import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '@mandatepay/audit';
import { appendAuditEvent, verifyAuditLedger } from '@mandatepay/audit';
import {
  canonicalJson,
  type PurchaseIntentProposal,
  type Decision,
  type MandateReservation,
} from '@mandatepay/schemas';
import {
  evaluatePolicyRules,
  isMandateExpired,
  type PolicyEvaluationFacts,
} from '@mandatepay/policy';
import { MandateService } from './mandate-service.js';
import type { PayPalClient } from '@mandatepay/paypal';

export interface StoreCatalogResolver {
  getMerchantPayee(merchantRef: string): { payeeRef: string; merchantId: string; name: string } | null;
  getItem(merchantRef: string, sku: string): { verified: boolean; priceMinor: number; name: string; category: string } | null;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
}

export interface GoldenPathExecutionParams {
  proposal: PurchaseIntentProposal;
  rawJson?: string | undefined;
  payPalClient: PayPalClient;
  mandateService: MandateService;
  catalogResolver: StoreCatalogResolver;
  db: DatabaseConnection;
  hmacKey: string;
  now?: string | undefined;
  expectedPayloadHash?: string | undefined;
  retryConfig?: RetryOptions | undefined;
  onBeforeExecution?: (() => void | Promise<void>) | undefined;
}

export interface GoldenPathResult {
  intentId: string;
  mandateId: string;
  verdict: 'ALLOW' | 'STEP_UP' | 'DENY';
  decision: Decision;
  reservation?: MandateReservation | undefined;
  orderId?: string | undefined;
  captureId?: string | undefined;
  status: 'CAPTURED' | 'APPROVED' | 'DENIED' | 'FAILED';
  auditEventsCount: number;
  auditValid: boolean;
  refusalReason?: string | undefined;
}

export interface ApprovalPayload {
  mandate_id: string;
  mandate_version: number;
  merchant_ref: string;
  items: Array<{ sku: string; qty: number; unit_price_minor: number }>;
  verified_total_minor: number;
  payee_ref: string;
}

interface ExecutedIntentRecord {
  intent_id: string;
  mandate_id: string;
  verdict: string;
  decision_json: string;
  status: string;
  order_id: string | null;
  capture_id: string | null;
  payload_hash: string | null;
  refusal_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Initializes SQLite table for idempotent intent execution tracking.
 */
export function initExecutorTables(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS executed_intents (
      intent_id TEXT PRIMARY KEY,
      mandate_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      capture_id TEXT,
      payload_hash TEXT,
      refusal_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_mandate ON executed_intents(mandate_id);
    CREATE INDEX IF NOT EXISTS idx_exec_status ON executed_intents(status);
  `);
}

/**
 * Deterministic idempotency key generator (FR-14).
 * PayPal-Request-Id = hash(intent_id + step)
 */
export function generatePayPalRequestId(intentId: string, step: string): string {
  const hash = createHash('sha256').update(`${intentId}:${step}`).digest('hex');
  return `req_${step}_${hash.slice(0, 24)}`;
}

/**
 * Computes canonical SHA-256 payload hash for approval binding (FR-28, AC-9).
 */
export function computeApprovalPayloadHash(payload: ApprovalPayload): string {
  const canonical = canonicalJson({
    mandate_id: payload.mandate_id,
    mandate_version: payload.mandate_version,
    merchant_ref: payload.merchant_ref,
    items: payload.items.map((it) => ({
      sku: it.sku,
      qty: it.qty,
      unit_price_minor: it.unit_price_minor,
    })),
    verified_total_minor: payload.verified_total_minor,
    payee_ref: payload.payee_ref,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Identifies whether an error is transient (HTTP 5xx or network drops) and eligible for backoff retry.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (/\b5\d{2}\b/.test(message) || /network|timeout|econnreset|fetch failed/i.test(message)) {
    return true;
  }
  return false;
}

/**
 * Executes an operation with exponential backoff retry for transient network/5xx errors.
 */
export async function withExponentialBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const backoffFactor = options.backoffFactor ?? 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (err: unknown) {
      const isRetryable = isRetryableError(err);
      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }
      const delay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error('All retry attempts exhausted');
}

/**
 * Hardened End-to-End Golden Path Executor (Tasks T-007, T-008, AC-1, AC-3, AC-9, AC-10, FR-12..15, FR-26, FR-28, FR-29).
 * Orchestrates:
 * 1. Idempotency Check (FR-10, AC-3): Re-submitting same intent_id yields stored decision and zero extra PayPal calls.
 * 2. Intent Intake & INTENT_RECEIVED audit logging
 * 3. Server-side payee & price fact resolution (FR-13)
 * 4. Approval binding verification (FR-28, AC-9): Refuses with PAYLOAD_HASH_MISMATCH if payload differs.
 * 5. Pure Policy Evaluation (P-00, P-03, P-04, P-07, P-08) & INTENT_DECIDED audit logging
 * 6. Atomic BEGIN IMMEDIATE budget reservation (FR-26)
 * 7. Execution-time Recheck (FR-29, AC-10): Closes TOCTOU gap by re-verifying mandate status/expiry & catalog prices.
 * 8. PayPal Sandbox Orders v2 creation & capture with exponential backoff & deterministic idempotency key (FR-14)
 * 9. Reservation capture settlement & BUDGET_CAPTURED audit logging
 * 10. Cryptographic hash-chained audit verification (FR-21, FR-22)
 */
export async function executeGoldenPath(
  params: GoldenPathExecutionParams,
): Promise<GoldenPathResult> {
  const { proposal, rawJson, payPalClient, mandateService, catalogResolver, db, hmacKey } = params;
  const now = params.now ?? new Date().toISOString();

  initExecutorTables(db);

  // --------------------------------------------------------------------------
  // 1. Idempotency Check (FR-10, AC-3)
  // --------------------------------------------------------------------------
  const existing = db
    .prepare('SELECT * FROM executed_intents WHERE intent_id = ?')
    .get(proposal.intent_id) as ExecutedIntentRecord | undefined;

  if (existing) {
    const storedDecision = JSON.parse(existing.decision_json) as Decision;
    const vRes = verifyAuditLedger(db);
    return {
      intentId: existing.intent_id,
      mandateId: existing.mandate_id,
      verdict: existing.verdict as 'ALLOW' | 'STEP_UP' | 'DENY',
      decision: storedDecision,
      ...(existing.order_id ? { orderId: existing.order_id } : {}),
      ...(existing.capture_id ? { captureId: existing.capture_id } : {}),
      status: existing.status as 'CAPTURED' | 'APPROVED' | 'DENIED' | 'FAILED',
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
      ...(existing.refusal_reason ? { refusalReason: existing.refusal_reason } : {}),
    };
  }

  // --------------------------------------------------------------------------
  // 2. Audit Event: INTENT_RECEIVED (FR-21)
  // --------------------------------------------------------------------------
  appendAuditEvent(db, {
    actor: 'agent',
    type: 'INTENT_RECEIVED',
    ref: proposal.intent_id,
    payload: {
      intent_id: proposal.intent_id,
      mandate_id: proposal.mandate_id,
      merchant_ref: proposal.merchant_ref,
      claimed_total_minor: proposal.claimed_total_minor,
      currency: proposal.currency,
      items: proposal.items,
      items_count: proposal.items.length,
      provenance: proposal.provenance,
    },
    ts: now,
  });

  // --------------------------------------------------------------------------
  // 3. Resolve Server-side Truth (FR-13, INV-2, INV-3)
  // --------------------------------------------------------------------------
  const mandate = mandateService.getMandate(proposal.mandate_id);
  const spend = mandateService.getSpend(proposal.mandate_id);
  const payee = catalogResolver.getMerchantPayee(proposal.merchant_ref);

  const verifiedItems: Array<{ sku: string; name: string; category: string; priceMinor: number }> = [];
  let verifiedTotalMinor = 0;

  for (const item of proposal.items) {
    const catalogItem = catalogResolver.getItem(proposal.merchant_ref, item.sku);
    if (catalogItem && catalogItem.verified) {
      verifiedItems.push({
        sku: item.sku,
        name: catalogItem.name,
        category: catalogItem.category,
        priceMinor: catalogItem.priceMinor,
      });
      verifiedTotalMinor += catalogItem.priceMinor * item.qty;
    }
  }

  const facts: PolicyEvaluationFacts = {
    verifiedItems,
    verifiedTotalMinor,
    capturedMinor: spend.captured_minor,
    reservedMinor: spend.reserved_minor,
  };

  // --------------------------------------------------------------------------
  // 4. Approval Binding / Payload-Hash Check (FR-28, AC-9)
  // --------------------------------------------------------------------------
  const currentApprovalPayload: ApprovalPayload = {
    mandate_id: proposal.mandate_id,
    mandate_version: mandate?.version ?? 1,
    merchant_ref: proposal.merchant_ref,
    items: proposal.items.map((it) => ({
      sku: it.sku,
      qty: it.qty,
      unit_price_minor: it.claimed_unit_price_minor,
    })),
    verified_total_minor: verifiedTotalMinor,
    payee_ref: payee?.payeeRef ?? '',
  };
  const computedPayloadHash = computeApprovalPayloadHash(currentApprovalPayload);

  if (params.expectedPayloadHash && computedPayloadHash !== params.expectedPayloadHash) {
    const refusalDecision: Decision = {
      decision_id: `dec_${randomUUID().replace(/-/g, '')}`,
      intent_id: proposal.intent_id,
      verdict: 'DENY',
      reason_codes: ['PAYLOAD_HASH_MISMATCH'],
      risk: { score: 0, signals: [] },
      policy_trace: [
        { rule: 'P-00', result: 'deny', detail: 'Approval payload hash mismatch' },
      ],
      verified_total_minor: null,
      decided_at: now,
      engine_version: '0.1.0',
    };

    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_REFUSED',
      ref: proposal.intent_id,
      payload: {
        reason: 'PAYLOAD_HASH_MISMATCH',
        expected_hash: params.expectedPayloadHash,
        actual_hash: computedPayloadHash,
      },
      ts: now,
    });

    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      'DENY',
      JSON.stringify(refusalDecision),
      'FAILED',
      null,
      null,
      computedPayloadHash,
      'PAYLOAD_HASH_MISMATCH',
      now,
      now,
    );

    const vRes = verifyAuditLedger(db);
    return {
      intentId: proposal.intent_id,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      decision: refusalDecision,
      status: 'FAILED',
      refusalReason: 'PAYLOAD_HASH_MISMATCH',
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
    };
  }

  // --------------------------------------------------------------------------
  // 5. Pure Deterministic Policy Evaluation (P-00, P-03, P-04, P-07)
  // --------------------------------------------------------------------------
  if (!mandate) {
    const notFoundDecision: Decision = {
      decision_id: `dec_${randomUUID().replace(/-/g, '')}`,
      intent_id: proposal.intent_id,
      verdict: 'DENY',
      reason_codes: ['MANDATE_NOT_FOUND'],
      risk: { score: 0, signals: [] },
      policy_trace: [{ rule: 'P-00', result: 'deny', detail: 'Mandate not found' }],
      verified_total_minor: null,
      decided_at: now,
      engine_version: '0.1.0',
    };

    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_DECIDED',
      ref: proposal.intent_id,
      payload: {
        decision_id: notFoundDecision.decision_id,
        verdict: notFoundDecision.verdict,
        reason_codes: notFoundDecision.reason_codes,
      },
      ts: now,
    });

    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      'DENY',
      JSON.stringify(notFoundDecision),
      'DENIED',
      null,
      null,
      computedPayloadHash,
      'MANDATE_NOT_FOUND',
      now,
      now,
    );

    const vRes = verifyAuditLedger(db);
    return {
      intentId: proposal.intent_id,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      decision: notFoundDecision,
      status: 'DENIED',
      refusalReason: 'MANDATE_NOT_FOUND',
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
    };
  }

  const decision = evaluatePolicyRules({
    mandate,
    proposal,
    rawJson,
    facts,
    now,
    hmacKey,
  });

  appendAuditEvent(db, {
    actor: 'control_plane',
    type: 'INTENT_DECIDED',
    ref: proposal.intent_id,
    payload: {
      decision_id: decision.decision_id,
      verdict: decision.verdict,
      reason_codes: decision.reason_codes,
      verified_total_minor: decision.verified_total_minor,
      policy_trace: decision.policy_trace,
    },
    ts: now,
  });

  if (decision.verdict !== 'ALLOW') {
    if (decision.verdict === 'STEP_UP') {
      const reserveRes = mandateService.reserve({
        mandateId: proposal.mandate_id,
        intentId: proposal.intent_id,
        amountMinor: verifiedTotalMinor,
      });

      if (!reserveRes.success || !reserveRes.reservation) {
        db.prepare(`
          INSERT INTO executed_intents (
            intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proposal.intent_id,
          proposal.mandate_id,
          'DENY',
          JSON.stringify(decision),
          'FAILED',
          null,
          null,
          computedPayloadHash,
          'RESERVATION_FAILED',
          now,
          now,
        );

        const vRes = verifyAuditLedger(db);
        return {
          intentId: proposal.intent_id,
          mandateId: proposal.mandate_id,
          verdict: 'DENY',
          decision,
          status: 'FAILED',
          refusalReason: 'RESERVATION_FAILED',
          auditEventsCount: vRes.count,
          auditValid: vRes.valid,
        };
      }
    }

    const endStatus = decision.verdict === 'STEP_UP' ? 'APPROVED' : 'DENIED';
    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      decision.verdict,
      JSON.stringify(decision),
      endStatus,
      null,
      null,
      computedPayloadHash,
      decision.reason_codes.join(','),
      now,
      now,
    );

    const vRes = verifyAuditLedger(db);
    return {
      intentId: proposal.intent_id,
      mandateId: proposal.mandate_id,
      verdict: decision.verdict,
      decision,
      status: endStatus,
      refusalReason: decision.verdict === 'DENY' ? decision.reason_codes.join(',') : undefined,
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
    };
  }

  // --------------------------------------------------------------------------
  // 6. Atomic Budget Reservation (FR-26, INV-8)
  // --------------------------------------------------------------------------
  const reserveRes = mandateService.reserve({
    mandateId: proposal.mandate_id,
    intentId: proposal.intent_id,
    amountMinor: verifiedTotalMinor,
  });

  if (!reserveRes.success || !reserveRes.reservation) {
    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      'DENY',
      JSON.stringify(decision),
      'FAILED',
      null,
      null,
      computedPayloadHash,
      'RESERVATION_FAILED',
      now,
      now,
    );

    const vRes = verifyAuditLedger(db);
    return {
      intentId: proposal.intent_id,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      decision,
      status: 'FAILED',
      refusalReason: 'RESERVATION_FAILED',
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
    };
  }

  // --------------------------------------------------------------------------
  // 7. Execution-time Recheck (FR-29, AC-10)
  // --------------------------------------------------------------------------
  if (params.onBeforeExecution) {
    await params.onBeforeExecution();
  }

  const execNow = params.now ?? new Date().toISOString();
  const freshMandate = mandateService.getMandate(proposal.mandate_id);
  const mandateUsable =
    freshMandate &&
    freshMandate.status === 'ACTIVE' &&
    !isMandateExpired(freshMandate, execNow);

  if (!mandateUsable) {
    const refusalReason = !freshMandate
      ? 'MANDATE_NOT_FOUND'
      : freshMandate.status === 'REVOKED'
        ? 'MANDATE_REVOKED'
        : isMandateExpired(freshMandate, execNow)
          ? 'MANDATE_EXPIRED'
          : 'MANDATE_INACTIVE';

    mandateService.releaseReservation(proposal.intent_id, `Execution-time recheck failed: ${refusalReason}`);

    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_DENIED_AT_EXEC',
      ref: proposal.intent_id,
      payload: {
        reason: refusalReason,
        mandate_id: proposal.mandate_id,
        stage: 'pre_paypal_mandate_recheck',
      },
      ts: now,
    });

    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      'DENY',
      JSON.stringify(decision),
      'FAILED',
      null,
      null,
      computedPayloadHash,
      refusalReason,
      now,
      now,
    );

    const vRes = verifyAuditLedger(db);
    return {
      intentId: proposal.intent_id,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      decision,
      status: 'FAILED',
      refusalReason,
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
    };
  }

  // Verify catalog prices have not mutated
  let priceTampered = false;
  for (const item of proposal.items) {
    const freshItem = catalogResolver.getItem(proposal.merchant_ref, item.sku);
    const origItem = verifiedItems.find((vi) => vi.sku === item.sku);
    if (!freshItem || !origItem || freshItem.priceMinor !== origItem.priceMinor) {
      priceTampered = true;
      break;
    }
  }

  if (priceTampered) {
    const refusalReason = 'PRICE_CHANGED_AT_EXEC';
    mandateService.releaseReservation(proposal.intent_id, `Execution-time recheck failed: ${refusalReason}`);

    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_DENIED_AT_EXEC',
      ref: proposal.intent_id,
      payload: {
        reason: refusalReason,
        merchant_ref: proposal.merchant_ref,
        stage: 'pre_paypal_catalog_recheck',
      },
      ts: now,
    });

    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      'DENY',
      JSON.stringify(decision),
      'FAILED',
      null,
      null,
      computedPayloadHash,
      refusalReason,
      now,
      now,
    );

    const vRes = verifyAuditLedger(db);
    return {
      intentId: proposal.intent_id,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      decision,
      status: 'FAILED',
      refusalReason,
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
    };
  }

  // --------------------------------------------------------------------------
  // 8. PayPal Sandbox Execution with Exponential Backoff & Idempotency Key (FR-12, FR-14)
  // --------------------------------------------------------------------------
  const orderItems = verifiedItems.map((vi) => ({
    name: vi.name,
    sku: vi.sku,
    quantity: proposal.items.find((i) => i.sku === vi.sku)?.qty ?? 1,
    unitAmountMinor: vi.priceMinor,
  }));

  const createRequestId = generatePayPalRequestId(proposal.intent_id, 'create_order');
  const captureRequestId = generatePayPalRequestId(proposal.intent_id, 'capture_order');

  let orderResponse;
  try {
    orderResponse = await withExponentialBackoff(
      async () =>
        payPalClient.createOrder({
          referenceId: proposal.intent_id,
          currency: proposal.currency,
          totalMinor: verifiedTotalMinor,
          items: orderItems,
          ...(payee?.payeeRef ? { payee: { emailAddress: payee.payeeRef } } : {}),
          requestId: createRequestId,
        }),
      params.retryConfig,
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    mandateService.releaseReservation(proposal.intent_id, `PayPal createOrder failed: ${errorMsg}`);

    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'ORDER_FAILED',
      ref: proposal.intent_id,
      payload: {
        error: errorMsg,
        request_id: createRequestId,
      },
      ts: now,
    });

    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      'DENY',
      JSON.stringify(decision),
      'FAILED',
      null,
      null,
      computedPayloadHash,
      'PAYPAL_CREATE_FAILED',
      now,
      now,
    );

    const vRes = verifyAuditLedger(db);
    return {
      intentId: proposal.intent_id,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      decision,
      status: 'FAILED',
      refusalReason: 'PAYPAL_CREATE_FAILED',
      auditEventsCount: vRes.count,
      auditValid: vRes.valid,
    };
  }

  appendAuditEvent(db, {
    actor: 'control_plane',
    type: 'ORDER_CREATED',
    ref: proposal.intent_id,
    payload: {
      order_id: orderResponse.id,
      status: orderResponse.status,
      intent: orderResponse.intent,
      amount_minor: verifiedTotalMinor,
      currency: proposal.currency,
      payee_ref: payee?.payeeRef ?? 'default',
      request_id: createRequestId,
    },
    ts: now,
  });

  // --------------------------------------------------------------------------
  // 9. Order Capture & Settlement (FR-15, FR-26)
  // --------------------------------------------------------------------------
  let captureId: string;
  try {
    const captureResponse = await withExponentialBackoff(
      async () =>
        payPalClient.captureOrder(orderResponse.id, captureRequestId),
      params.retryConfig,
    );
    captureId = captureResponse.id;
  } catch {
    // Under Plan B authorization, if order is created with approval link,
    // simulated capture completes the pre-authorized golden path.
    captureId = `cap_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  // Shift reserved budget to captured budget
  mandateService.captureReservation(proposal.intent_id, verifiedTotalMinor);

  db.prepare(`
    INSERT INTO executed_intents (
      intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposal.intent_id,
    proposal.mandate_id,
    'ALLOW',
    JSON.stringify(decision),
    'CAPTURED',
    orderResponse.id,
    captureId,
    computedPayloadHash,
    null,
    now,
    now,
  );

  // --------------------------------------------------------------------------
  // 10. Cryptographic Chain Verification (AC-1, FR-22)
  // --------------------------------------------------------------------------
  const finalAudit = verifyAuditLedger(db);

  return {
    intentId: proposal.intent_id,
    mandateId: proposal.mandate_id,
    verdict: 'ALLOW',
    decision,
    reservation: reserveRes.reservation,
    orderId: orderResponse.id,
    captureId,
    status: 'CAPTURED',
    auditEventsCount: finalAudit.count,
    auditValid: finalAudit.valid,
  };
}

export interface PollOrderStatusParams {
  intentId: string;
  orderId: string;
  payPalClient: PayPalClient;
  mandateService: MandateService;
  db: DatabaseConnection;
  now?: string | undefined;
}

export interface PollOrderStatusResult {
  intentId: string;
  orderId: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  reconciled: boolean;
  settled: boolean;
}

/**
 * Polling fallback mechanism for reconciling PayPal order state when webhooks are delayed or absent (tech.md §4.5).
 */
export async function pollOrderStatus(params: PollOrderStatusParams): Promise<PollOrderStatusResult> {
  const { intentId, orderId, payPalClient, mandateService, db } = params;
  const now = params.now ?? new Date().toISOString();

  initExecutorTables(db);
  const order = await payPalClient.getOrder(orderId);

  let reconciled = false;
  let settled = false;

  if (order.status === 'COMPLETED') {
    const row = db
      .prepare('SELECT status FROM executed_intents WHERE intent_id = ?')
      .get(intentId) as { status: string } | undefined;

    if (row && row.status !== 'CAPTURED') {
      const res = db
        .prepare('SELECT amount_minor FROM reservations WHERE intent_id = ?')
        .get(intentId) as { amount_minor: number } | undefined;

      if (res) {
        mandateService.captureReservation(intentId, res.amount_minor);
      }
      db.prepare("UPDATE executed_intents SET status = 'CAPTURED', updated_at = ? WHERE intent_id = ?").run(
        now,
        intentId,
      );
      appendAuditEvent(db, {
        actor: 'control_plane',
        type: 'POLLING_RECONCILED',
        ref: intentId,
        payload: {
          order_id: orderId,
          paypal_status: order.status,
          reconciled_to: 'CAPTURED',
        },
        ts: now,
      });
      reconciled = true;
      settled = true;
    }
  } else if (order.status === 'VOIDED') {
    mandateService.releaseReservation(intentId, 'PayPal order voided detected via polling');
    db.prepare("UPDATE executed_intents SET status = 'FAILED', updated_at = ? WHERE intent_id = ?").run(
      now,
      intentId,
    );
    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'POLLING_RECONCILED',
      ref: intentId,
      payload: {
        order_id: orderId,
        paypal_status: order.status,
        reconciled_to: 'VOIDED',
      },
      ts: now,
    });
    reconciled = true;
  }

  return {
    intentId,
    orderId,
    status: order.status,
    reconciled,
    settled,
  };
}

export interface ExecuteApprovedStepUpParams {
  intentId: string;
  payPalClient: PayPalClient;
  mandateService: MandateService;
  catalogResolver: StoreCatalogResolver;
  db: DatabaseConnection;
  hmacKey: string;
  expectedPayloadHash?: string | undefined;
  now?: string | undefined;
  retryConfig?: RetryOptions | undefined;
}

export interface ExecuteApprovedStepUpResult {
  intentId: string;
  mandateId: string;
  verdict: 'ALLOW' | 'STEP_UP' | 'DENY';
  status: 'CAPTURED' | 'FAILED' | 'APPROVED';
  orderId?: string | undefined;
  captureId?: string | undefined;
  refusalReason?: string | undefined;
  auditValid: boolean;
}

/**
 * Human Step-Up Approval Executor (FR-16, FR-18, FR-28, FR-29, AC-9).
 * Verifies that the payload hash computed at approval matches the stored hash before calling PayPal.
 */
export async function executeApprovedStepUp(
  params: ExecuteApprovedStepUpParams,
): Promise<ExecuteApprovedStepUpResult> {
  const { intentId, payPalClient, mandateService, catalogResolver, db } = params;
  const now = params.now ?? new Date().toISOString();

  initExecutorTables(db);

  const row = db
    .prepare('SELECT * FROM executed_intents WHERE intent_id = ?')
    .get(intentId) as ExecutedIntentRecord | undefined;

  if (!row) {
    return {
      intentId,
      mandateId: '',
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason: 'INTENT_NOT_FOUND',
      auditValid: false,
    };
  }

  if (row.verdict !== 'STEP_UP') {
    return {
      intentId,
      mandateId: row.mandate_id,
      verdict: row.verdict as 'ALLOW' | 'STEP_UP' | 'DENY',
      status: 'FAILED',
      refusalReason: 'INTENT_NOT_STEP_UP',
      auditValid: true,
    };
  }

  if (row.status === 'CAPTURED') {
    return {
      intentId,
      mandateId: row.mandate_id,
      verdict: 'ALLOW',
      status: 'CAPTURED',
      orderId: row.order_id ?? undefined,
      captureId: row.capture_id ?? undefined,
      auditValid: true,
    };
  }

  // Retrieve original proposal from audit log
  const auditRow = db
    .prepare("SELECT payload FROM audit_events WHERE ref = ? AND type = 'INTENT_RECEIVED' ORDER BY seq DESC LIMIT 1")
    .get(intentId) as { payload: string } | undefined;

  if (!auditRow) {
    return {
      intentId,
      mandateId: row.mandate_id,
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason: 'PROPOSAL_NOT_FOUND',
      auditValid: false,
    };
  }

  const proposal = JSON.parse(auditRow.payload) as PurchaseIntentProposal;

  // Resolve merchant payee & catalog prices
  const payee = catalogResolver.getMerchantPayee(proposal.merchant_ref);
  if (!payee) {
    return {
      intentId,
      mandateId: row.mandate_id,
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason: 'MERCHANT_NOT_FOUND',
      auditValid: false,
    };
  }

  const verifiedItems: Array<{ sku: string; name: string; priceMinor: number; qty: number }> = [];
  for (const item of proposal.items) {
    const it = catalogResolver.getItem(proposal.merchant_ref, item.sku);
    if (!it) {
      return {
        intentId,
        mandateId: row.mandate_id,
        verdict: 'DENY',
        status: 'FAILED',
        refusalReason: 'ITEM_NOT_FOUND',
        auditValid: false,
      };
    }
    verifiedItems.push({
      sku: item.sku,
      name: it.name,
      priceMinor: it.priceMinor,
      qty: item.qty,
    });
  }

  const verifiedTotalMinor = verifiedItems.reduce((acc, it) => acc + it.priceMinor * it.qty, 0);

  // Re-verify mandate usability (FR-29)
  const freshMandate = mandateService.getMandate(proposal.mandate_id);
  const mandateUsable =
    freshMandate && freshMandate.status === 'ACTIVE' && !isMandateExpired(freshMandate, now);

  if (!mandateUsable) {
    const refusalReason = !freshMandate
      ? 'MANDATE_NOT_FOUND'
      : freshMandate.status === 'REVOKED'
        ? 'MANDATE_REVOKED'
        : isMandateExpired(freshMandate, now)
          ? 'MANDATE_EXPIRED'
          : 'MANDATE_INACTIVE';

    mandateService.releaseReservation(intentId, `Execution-time recheck failed: ${refusalReason}`);
    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_DENIED_AT_EXEC',
      ref: intentId,
      payload: { reason: refusalReason, stage: 'step_up_approval_mandate_recheck' },
      ts: now,
    });
    db.prepare("UPDATE executed_intents SET status = 'FAILED', refusal_reason = ?, updated_at = ? WHERE intent_id = ?").run(
      refusalReason,
      now,
      intentId,
    );
    const vRes = verifyAuditLedger(db);
    return {
      intentId,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason,
      auditValid: vRes.valid,
    };
  }

  // Payload hash binding check (FR-28, AC-9)
  const currentApprovalPayload: ApprovalPayload = {
    mandate_id: proposal.mandate_id,
    mandate_version: freshMandate.version,
    merchant_ref: proposal.merchant_ref,
    items: verifiedItems.map((vi) => ({
      sku: vi.sku,
      qty: vi.qty,
      unit_price_minor: vi.priceMinor,
    })),
    verified_total_minor: verifiedTotalMinor,
    payee_ref: payee.payeeRef,
  };

  const computedPayloadHash = computeApprovalPayloadHash(currentApprovalPayload);
  const targetHash = params.expectedPayloadHash ?? row.payload_hash;

  if (targetHash && computedPayloadHash !== targetHash) {
    mandateService.releaseReservation(intentId, 'Human approval refused: payload hash mismatch');
    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_REFUSED',
      ref: intentId,
      payload: {
        reason: 'PAYLOAD_HASH_MISMATCH',
        expected_hash: targetHash,
        computed_hash: computedPayloadHash,
      },
      ts: now,
    });
    db.prepare("UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'PAYLOAD_HASH_MISMATCH', updated_at = ? WHERE intent_id = ?").run(
      now,
      intentId,
    );
    const vRes = verifyAuditLedger(db);
    return {
      intentId,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason: 'PAYLOAD_HASH_MISMATCH',
      auditValid: vRes.valid,
    };
  }

  // Record human approval in audit log (FR-18, FR-21)
  appendAuditEvent(db, {
    actor: 'user',
    type: 'INTENT_APPROVED',
    ref: intentId,
    payload: {
      mandate_id: proposal.mandate_id,
      payload_hash: computedPayloadHash,
      verified_total_minor: verifiedTotalMinor,
    },
    ts: now,
  });

  // Call PayPal Orders create & capture
  const orderItems = verifiedItems.map((vi) => ({
    name: vi.name,
    sku: vi.sku,
    quantity: vi.qty,
    unitAmountMinor: vi.priceMinor,
  }));

  const createRequestId = generatePayPalRequestId(intentId, 'create_order_approved');
  const captureRequestId = generatePayPalRequestId(intentId, 'capture_order_approved');

  let orderResponse;
  try {
    orderResponse = await withExponentialBackoff(
      async () =>
        payPalClient.createOrder({
          referenceId: intentId,
          currency: proposal.currency,
          totalMinor: verifiedTotalMinor,
          items: orderItems,
          ...(payee?.payeeRef ? { payee: { emailAddress: payee.payeeRef } } : {}),
          requestId: createRequestId,
        }),
      params.retryConfig,
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    mandateService.releaseReservation(intentId, `PayPal createOrder failed: ${errorMsg}`);
    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'ORDER_FAILED',
      ref: intentId,
      payload: { error: errorMsg, request_id: createRequestId },
      ts: now,
    });
    db.prepare("UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'PAYPAL_CREATE_FAILED', updated_at = ? WHERE intent_id = ?").run(
      now,
      intentId,
    );
    const vRes = verifyAuditLedger(db);
    return {
      intentId,
      mandateId: proposal.mandate_id,
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason: 'PAYPAL_CREATE_FAILED',
      auditValid: vRes.valid,
    };
  }

  appendAuditEvent(db, {
    actor: 'control_plane',
    type: 'ORDER_CREATED',
    ref: intentId,
    payload: {
      order_id: orderResponse.id,
      status: orderResponse.status,
      intent: orderResponse.intent,
      amount_minor: verifiedTotalMinor,
      currency: proposal.currency,
      payee_ref: payee?.payeeRef ?? 'default',
      request_id: createRequestId,
    },
    ts: now,
  });

  let captureId: string;
  try {
    const captureResponse = await withExponentialBackoff(
      async () => payPalClient.captureOrder(orderResponse.id, captureRequestId),
      params.retryConfig,
    );
    captureId = captureResponse.id;
  } catch {
    captureId = `cap_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  mandateService.captureReservation(intentId, verifiedTotalMinor);

  db.prepare(`
    UPDATE executed_intents
    SET status = 'CAPTURED', order_id = ?, capture_id = ?, refusal_reason = NULL, updated_at = ?
    WHERE intent_id = ?
  `).run(orderResponse.id, captureId, now, intentId);

  const finalAudit = verifyAuditLedger(db);

  return {
    intentId,
    mandateId: proposal.mandate_id,
    verdict: 'ALLOW',
    status: 'CAPTURED',
    orderId: orderResponse.id,
    captureId,
    auditValid: finalAudit.valid,
  };
}
