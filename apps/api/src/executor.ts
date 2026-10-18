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
import { scanAdvisoryText } from '@mandatepay/scanner';
import { MandateService, withImmediateTransaction } from './mandate-service.js';
import type { PayPalClient, PayPalOrderResponse } from '@mandatepay/paypal';

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
  approveUrl?: string | undefined;
  status: 'CAPTURED' | 'APPROVED' | 'DENIED' | 'FAILED' | 'AWAITING_PAYER_APPROVAL';
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
  merchant_ref?: string | null;
  verdict: string;
  decision_json: string;
  status: string;
  order_id: string | null;
  capture_id: string | null;
  payload_hash: string | null;
  refusal_reason: string | null;
  approve_url?: string | null;
  expires_at?: string | null;
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
      merchant_ref TEXT,
      verdict TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      capture_id TEXT,
      payload_hash TEXT,
      refusal_reason TEXT,
      approve_url TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_mandate ON executed_intents(mandate_id);
    CREATE INDEX IF NOT EXISTS idx_exec_status ON executed_intents(status);

    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      merchant_ref TEXT NOT NULL,
      payee_ref TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_intent ON orders(intent_id);
  `);
  try {
    db.exec('ALTER TABLE executed_intents ADD COLUMN approve_url TEXT;');
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE executed_intents ADD COLUMN expires_at TEXT;');
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE executed_intents ADD COLUMN merchant_ref TEXT;');
  } catch {
    // column already exists
  }
}

/**
 * Strict numeric epoch expiry comparator (NFR-6, AC-12).
 * Replaces lexicographical ISO string comparisons.
 * Fails closed (returns true) if either timestamp is NaN or unparseable.
 */
export function isExpiredEpoch(expiresAt: string | null | undefined, now: string): boolean {
  if (!expiresAt) return false;
  const expiryEpoch = Date.parse(expiresAt);
  const nowEpoch = Date.parse(now);
  if (Number.isNaN(expiryEpoch) || Number.isNaN(nowEpoch)) {
    return true; // Fail closed if unparseable
  }
  return expiryEpoch <= nowEpoch;
}

/**
 * Expiry Sweeper (FR-34, AC-12).
 * Periodically transitions unapproved intents past payer_approval_timeout_seconds to EXPIRED,
 * atomically releases reservations, and writes INTENT_EXPIRED audit events.
 * Uses strict numeric epoch comparison (NFR-6).
 */
export function sweepExpiredIntents(
  db: DatabaseConnection,
  mandateService: MandateService,
  now?: string,
): string[] {
  const currentNow = now ?? new Date().toISOString();
  initExecutorTables(db);

  const candidates = db
    .prepare(
      `SELECT intent_id, order_id, expires_at, status, verdict FROM executed_intents
       WHERE (status = 'AWAITING_PAYER_APPROVAL' OR (status = 'APPROVED' AND verdict = 'STEP_UP'))
         AND expires_at IS NOT NULL`,
    )
    .all() as Array<{ intent_id: string; order_id: string | null; expires_at: string; status: string; verdict: string }>;

  const expiredIds: string[] = [];

  for (const candidate of candidates) {
    if (!isExpiredEpoch(candidate.expires_at, currentNow)) {
      continue;
    }

    withImmediateTransaction(db, () => {
      const row = db
        .prepare('SELECT status, verdict, expires_at, order_id FROM executed_intents WHERE intent_id = ?')
        .get(candidate.intent_id) as { status: string; verdict: string; expires_at: string; order_id: string | null } | undefined;

      if (
        !row ||
        (row.status !== 'AWAITING_PAYER_APPROVAL' && !(row.status === 'APPROVED' && row.verdict === 'STEP_UP')) ||
        !isExpiredEpoch(row.expires_at, currentNow)
      ) {
        return; // Already processed or concurrent capture won
      }

      const timeoutReason = row.verdict === 'STEP_UP' ? 'STEP_UP_TIMEOUT' : 'PAYER_APPROVAL_TIMEOUT';
      const releaseMsg = row.verdict === 'STEP_UP' ? 'Step-up approval timeout exceeded' : 'Approval timeout exceeded';

      const res = mandateService.getReservation(candidate.intent_id);
      if (res && res.state === 'HELD') {
        mandateService.releaseReservation(candidate.intent_id, releaseMsg);
      }

      db.prepare(
        "UPDATE executed_intents SET status = 'EXPIRED', refusal_reason = ?, updated_at = ? WHERE intent_id = ?",
      ).run(timeoutReason, currentNow, candidate.intent_id);

      appendAuditEvent(db, {
        actor: 'control_plane',
        type: 'INTENT_EXPIRED',
        ref: candidate.intent_id,
        payload: {
          intent_id: candidate.intent_id,
          order_id: row.order_id,
          expires_at: row.expires_at,
          expired_at: currentNow,
          reason: timeoutReason,
        },
        ts: currentNow,
      });

      expiredIds.push(candidate.intent_id);
    });
  }

  return expiredIds;
}

/**
 * Lazy check on intent/approve calls (FR-34, AC-12).
 * If unapproved order or pending step-up has passed expires_at (epoch comparison), transitions to EXPIRED, releases reservation, and logs audit.
 */
export function checkAndExpireIntent(
  db: DatabaseConnection,
  mandateService: MandateService,
  intentId: string,
  now?: string,
): boolean {
  const currentNow = now ?? new Date().toISOString();
  initExecutorTables(db);

  return withImmediateTransaction(db, () => {
    const row = db
      .prepare('SELECT status, verdict, expires_at, order_id FROM executed_intents WHERE intent_id = ?')
      .get(intentId) as { status: string; verdict: string; expires_at: string | null; order_id: string | null } | undefined;

    if (
      !row ||
      (row.status !== 'AWAITING_PAYER_APPROVAL' && !(row.status === 'APPROVED' && row.verdict === 'STEP_UP')) ||
      !row.expires_at ||
      !isExpiredEpoch(row.expires_at, currentNow)
    ) {
      return false;
    }

    const timeoutReason = row.verdict === 'STEP_UP' ? 'STEP_UP_TIMEOUT' : 'PAYER_APPROVAL_TIMEOUT';
    const releaseMsg = row.verdict === 'STEP_UP' ? 'Step-up approval timeout exceeded' : 'Approval timeout exceeded';

    const res = mandateService.getReservation(intentId);
    if (res && res.state === 'HELD') {
      mandateService.releaseReservation(intentId, releaseMsg);
    }

    db.prepare(
      "UPDATE executed_intents SET status = 'EXPIRED', refusal_reason = ?, updated_at = ? WHERE intent_id = ?",
    ).run(timeoutReason, currentNow, intentId);

    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_EXPIRED',
      ref: intentId,
      payload: {
        intent_id: intentId,
        order_id: row.order_id,
        expires_at: row.expires_at,
        expired_at: currentNow,
        reason: timeoutReason,
      },
      ts: currentNow,
    });

    return true;
  });
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
export interface CreateMandatePayPalOrderParams {
  payPalClient: PayPalClient;
  intentId: string;
  currency: string;
  totalMinor: number;
  items: Array<{ name: string; sku: string; quantity: number; unitAmountMinor: number }>;
  payeeRef: string;
  requestId: string;
  retryConfig?: RetryOptions | undefined;
}

/**
 * Unified PayPal order creation helper conforming strictly to INV-2.
 * SOURCING GUARANTEE: Payee is strictly resolved from the authoritative server-side merchant registry,
 * completely ignoring any payee hints, emails, or strings from agent proposals/rationale.
 */
export async function createMandatePayPalOrder(
  params: CreateMandatePayPalOrderParams,
): Promise<PayPalOrderResponse> {
  const { payPalClient, intentId, currency, totalMinor, items, payeeRef, requestId, retryConfig } = params;

  return withExponentialBackoff(
    async () =>
      payPalClient.createOrder({
        referenceId: intentId,
        currency,
        totalMinor,
        items,
        payee: { emailAddress: payeeRef },
        requestId,
      }),
    retryConfig,
  );
}

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

  const pendingApprovalsCount = (
    db.prepare(`
      SELECT count(*) as count FROM executed_intents
      WHERE mandate_id = ? AND verdict = 'STEP_UP' AND status IN ('PENDING_APPROVAL', 'APPROVED', 'AWAITING_PAYER_APPROVAL')
    `).get(proposal.mandate_id) as { count: number } | undefined
  )?.count ?? 0;

  const textToScan = `${proposal.rationale ?? ''} ${proposal.user_goal_ref ?? ''}`;
  const scanResult = scanAdvisoryText(textToScan);

  const facts: PolicyEvaluationFacts = {
    verifiedItems,
    verifiedTotalMinor,
    capturedMinor: spend.captured_minor,
    reservedMinor: spend.reserved_minor,
    pendingApprovals: pendingApprovalsCount,
    riskResult: { score: scanResult.risk_score, signals: scanResult.flags },
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
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      proposal.merchant_ref,
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
            intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proposal.intent_id,
          proposal.mandate_id,
          proposal.merchant_ref,
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
    const stepUpTimeout = mandate?.step_up?.timeout_seconds ?? 300;
    const stepUpExpiresAt = decision.verdict === 'STEP_UP'
      ? new Date(new Date(now).getTime() + stepUpTimeout * 1000).toISOString()
      : null;

    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      proposal.merchant_ref,
      decision.verdict,
      JSON.stringify(decision),
      endStatus,
      null,
      null,
      computedPayloadHash,
      decision.reason_codes.join(','),
      stepUpExpiresAt,
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
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      proposal.merchant_ref,
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
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      proposal.merchant_ref,
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

  let orderResponse: PayPalOrderResponse;
  try {
    orderResponse = await createMandatePayPalOrder({
      payPalClient,
      intentId: proposal.intent_id,
      currency: proposal.currency,
      totalMinor: verifiedTotalMinor,
      items: orderItems,
      payeeRef: payee?.payeeRef ?? '',
      requestId: createRequestId,
      retryConfig: params.retryConfig,
    });
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
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.intent_id,
      proposal.mandate_id,
      proposal.merchant_ref,
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
  // 9. Plan B Order State & Reservation (FR-33, FR-34)
  // --------------------------------------------------------------------------
  const timeoutSeconds = freshMandate.payer_approval_timeout_seconds ?? 900;
  const expiresAt = new Date(new Date(now).getTime() + timeoutSeconds * 1000).toISOString();
  const approveUrl = orderResponse.links?.find((l) => l.rel === 'approve')?.href;

  appendAuditEvent(db, {
    actor: 'control_plane',
    type: 'AWAITING_PAYER_APPROVAL',
    ref: proposal.intent_id,
    payload: {
      order_id: orderResponse.id,
      approve_url: approveUrl,
      expires_at: expiresAt,
      reservation_state: 'HELD',
    },
    ts: now,
  });

  db.prepare(`
    INSERT INTO executed_intents (
      intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, approve_url, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposal.intent_id,
    proposal.mandate_id,
    proposal.merchant_ref,
    'ALLOW',
    JSON.stringify(decision),
    'AWAITING_PAYER_APPROVAL',
    orderResponse.id,
    null,
    computedPayloadHash,
    null,
    approveUrl ?? null,
    expiresAt,
    now,
    now,
  );

  db.prepare(`
    INSERT OR REPLACE INTO orders (order_id, intent_id, merchant_ref, payee_ref, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    orderResponse.id,
    proposal.intent_id,
    proposal.merchant_ref,
    payee?.payeeRef ?? '',
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
    approveUrl,
    status: 'AWAITING_PAYER_APPROVAL',
    auditEventsCount: finalAudit.count,
    auditValid: finalAudit.valid,
  };
}

export interface CaptureApprovedOrderParams {
  intentId: string;
  payPalClient: PayPalClient;
  mandateService: MandateService;
  catalogResolver: StoreCatalogResolver;
  db: DatabaseConnection;
  now?: string | undefined;
  retryConfig?: RetryOptions | undefined;
}

export interface CaptureApprovedOrderResult {
  intentId: string;
  orderId?: string | undefined;
  captureId?: string | undefined;
  status: 'CAPTURED' | 'FAILED' | 'EXPIRED' | 'AWAITING_PAYER_APPROVAL' | 'CAPTURING';
  refusalReason?: string | undefined;
}

/**
 * Single authoritative capture function (Guardrail 2, FR-34, FR-35, FR-37, AC-12, AC-13, AC-14).
 * ALL capture pathways (approve endpoint, webhook, polling, startup reconcile) MUST route through this function.
 * 
 * Guarantees:
 * 1. Atomically flips status to CAPTURING inside BEGIN IMMEDIATE after asserting reservation is HELD and not expired.
 * 2. Zero PayPal calls inside SQLite transactions.
 * 3. Pre-capture preflight asserts order status, reference_id, amount/currency, payee, and payer_binding.
 * 4. Refuses capture with zero captureOrder calls if preflight fails, order unapproved, or expired.
 * 5. Uses deterministic PayPal-Request-Id.
 * 6. Handles ORDER_ALREADY_CAPTURED error by querying GET order and recording reconciled state.
 */
export async function captureApprovedOrder(
  params: CaptureApprovedOrderParams,
): Promise<CaptureApprovedOrderResult> {
  const { intentId, payPalClient, mandateService, catalogResolver, db } = params;
  const now = params.now ?? new Date().toISOString();

  initExecutorTables(db);

  // STEP A: Atomic validation and status transition to CAPTURING inside BEGIN IMMEDIATE transaction
  const preCheck = withImmediateTransaction(db, () => {
    const row = db
      .prepare('SELECT * FROM executed_intents WHERE intent_id = ?')
      .get(intentId) as ExecutedIntentRecord | undefined;

    if (!row) {
      return { ok: false, status: 'FAILED' as const, reason: 'INTENT_NOT_FOUND' };
    }

    if (row.status === 'CAPTURED') {
      return {
        ok: true,
        alreadyCaptured: true,
        status: 'CAPTURED' as const,
        orderId: row.order_id ?? undefined,
        captureId: row.capture_id ?? undefined,
      };
    }

    // Lazy check on approval TTL with numeric epoch comparison (FR-34, AC-12, NFR-6)
    if (row.expires_at && isExpiredEpoch(row.expires_at, now)) {
      const timeoutReason = row.verdict === 'STEP_UP' ? 'STEP_UP_TIMEOUT' : 'PAYER_APPROVAL_TIMEOUT';
      const releaseMsg = row.verdict === 'STEP_UP' ? 'Step-up approval timeout exceeded' : 'Approval timeout exceeded';
      if (row.status !== 'EXPIRED') {
        const res = mandateService.getReservation(intentId);
        if (res && res.state === 'HELD') {
          mandateService.releaseReservation(intentId, releaseMsg);
        }
        db.prepare(
          "UPDATE executed_intents SET status = 'EXPIRED', refusal_reason = ?, updated_at = ? WHERE intent_id = ?",
        ).run(timeoutReason, now, intentId);
        appendAuditEvent(db, {
          actor: 'control_plane',
          type: 'INTENT_EXPIRED',
          ref: intentId,
          payload: {
            intent_id: intentId,
            order_id: row.order_id,
            expires_at: row.expires_at,
            expired_at: now,
            reason: timeoutReason,
          },
          ts: now,
        });
      }
      return { ok: false, status: 'EXPIRED' as const, reason: timeoutReason };
    }

    if (row.status === 'EXPIRED') {
      const timeoutReason = row.verdict === 'STEP_UP' ? 'STEP_UP_TIMEOUT' : 'PAYER_APPROVAL_TIMEOUT';
      return { ok: false, status: 'EXPIRED' as const, reason: row.refusal_reason ?? timeoutReason };
    }

    if (row.status === 'FAILED' || row.status === 'DENIED' || row.status === 'REJECTED') {
      return { ok: false, status: 'FAILED' as const, reason: row.refusal_reason ?? row.status };
    }

    if (!row.order_id) {
      const reason = row.verdict === 'STEP_UP' ? 'STEP_UP_NOT_CONFIRMED' : 'NO_ORDER_ID';
      return { ok: false, status: 'FAILED' as const, reason };
    }

    // Assert reservation is HELD before allowing capture (FR-34, AC-12, INV-7)
    const reservation = mandateService.getReservation(intentId);
    if (!reservation || reservation.state !== 'HELD') {
      return { ok: false, status: 'FAILED' as const, reason: 'RESERVATION_NOT_HELD' };
    }

    // Resolve merchant_ref deterministically from server-side intent / orders record (INV-2)
    let merchantRef = row.merchant_ref;
    if (!merchantRef && row.order_id) {
      const orderRow = db
        .prepare('SELECT merchant_ref FROM orders WHERE order_id = ?')
        .get(row.order_id) as { merchant_ref: string } | undefined;
      if (orderRow) merchantRef = orderRow.merchant_ref;
    }
    if (!merchantRef) {
      const orderRow = db
        .prepare('SELECT merchant_ref FROM orders WHERE intent_id = ?')
        .get(intentId) as { merchant_ref: string } | undefined;
      if (orderRow) merchantRef = orderRow.merchant_ref;
    }

    // Atomically flip intent status to CAPTURING inside BEGIN IMMEDIATE transaction (FR-34)
    db.prepare(
      "UPDATE executed_intents SET status = 'CAPTURING', updated_at = ? WHERE intent_id = ?",
    ).run(now, intentId);

    return {
      ok: true,
      alreadyCaptured: false,
      status: 'CAPTURING' as const,
      orderId: row.order_id,
      mandateId: row.mandate_id,
      amountMinor: reservation.amount_minor,
      merchantRef: merchantRef ?? undefined,
    };
  });

  if (!preCheck.ok) {
    return {
      intentId,
      status: preCheck.status,
      refusalReason: preCheck.reason,
    };
  }

  if (preCheck.alreadyCaptured) {
    return {
      intentId,
      orderId: preCheck.orderId,
      captureId: preCheck.captureId,
      status: 'CAPTURED',
    };
  }

  const targetOrderId = preCheck.orderId!;
  const mandateId = preCheck.mandateId!;
  const verifiedTotalMinor = preCheck.amountMinor!;
  const merchantRef = preCheck.merchantRef;
  const mandate = mandateService.getMandate(mandateId);

  let captureExecutedOnPayPal = false;

  try {
    // STEP B: Outside transaction — Pre-capture preflight against PayPal (FR-35, AC-13)
    let fetchedOrder: PayPalOrderResponse;
    try {
      fetchedOrder = await payPalClient.getOrder(targetOrderId);
    } catch (err: unknown) {
      // Prevent stuck CAPTURING: Network or 5xx error on initial getOrder transitions to FAILED and releases reservation atomically
      const errorMsg = err instanceof Error ? err.message : String(err);
      withImmediateTransaction(db, () => {
        mandateService.releaseReservation(intentId, `PayPal getOrder failed: ${errorMsg}`);
        appendAuditEvent(db, {
          actor: 'control_plane',
          type: 'ORDER_FAILED',
          ref: intentId,
          payload: { error: errorMsg, stage: 'preflight_get_order', order_id: targetOrderId },
          ts: now,
        });
        db.prepare(
          "UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'GET_ORDER_FAILED', updated_at = ? WHERE intent_id = ?",
        ).run(now, intentId);
      });
      return {
        intentId,
        orderId: targetOrderId,
        status: 'FAILED',
        refusalReason: `GET_ORDER_FAILED: ${errorMsg}`,
      };
    }

    // If order status is CREATED, order is still awaiting buyer approval (Plan B lifecycle)
    if (fetchedOrder.status === 'CREATED') {
      withImmediateTransaction(db, () => {
        db.prepare(
          "UPDATE executed_intents SET status = 'AWAITING_PAYER_APPROVAL', updated_at = ? WHERE intent_id = ? AND status = 'CAPTURING'",
        ).run(now, intentId);
      });
      return {
        intentId,
        orderId: targetOrderId,
        status: 'AWAITING_PAYER_APPROVAL',
        refusalReason: 'ORDER_NOT_YET_APPROVED',
      };
    }

    // Strict Fail-Closed Preflight Assertions (FR-35, INV-6, INV-7)
    // In captureApprovedOrder, reference_id, amount.value, amount.currency_code, and payee MUST all be present and strictly match expected server values.
    // If ANY field is missing or undefined -> immediately fail with PREFLIGHT_VALIDATION_FAILED, release reservation, write audit event, and make ZERO captureOrder calls.
    let validatedPayeeRef: string | undefined;
    try {
      if (fetchedOrder.status !== 'APPROVED' && fetchedOrder.status !== 'COMPLETED') {
        throw new Error(`Order preflight failed: status '${fetchedOrder.status}' is not APPROVED or COMPLETED`);
      }

      const purchaseUnit = fetchedOrder.purchase_units?.[0];
      if (!purchaseUnit) {
        throw new Error('Order preflight failed: missing purchase_units[0]');
      }

      // 1. reference_id MUST be present and strictly match intent_id
      if (!purchaseUnit.reference_id) {
        throw new Error('Order preflight failed: missing reference_id in purchase unit');
      }
      if (purchaseUnit.reference_id !== intentId) {
        throw new Error(`Order preflight failed: reference_id '${purchaseUnit.reference_id}' !== intent '${intentId}'`);
      }

      // 2. amount.value and amount.currency_code MUST be present and strictly match expected server values
      if (!purchaseUnit.amount || !purchaseUnit.amount.value || !purchaseUnit.amount.currency_code) {
        throw new Error('Order preflight failed: missing amount, amount.value, or amount.currency_code');
      }
      const expectedCurrency = mandate?.currency ?? 'USD';
      if (purchaseUnit.amount.currency_code !== expectedCurrency) {
        throw new Error(`Order preflight failed: currency '${purchaseUnit.amount.currency_code}' !== '${expectedCurrency}'`);
      }
      const parsedAmountVal = parseFloat(purchaseUnit.amount.value);
      if (Number.isNaN(parsedAmountVal)) {
        throw new Error(`Order preflight failed: amount value '${purchaseUnit.amount.value}' is not a valid number`);
      }
      const fetchedAmountMinor = Math.round(parsedAmountVal * 100);
      if (fetchedAmountMinor !== verifiedTotalMinor) {
        throw new Error(`Order preflight failed: amount ${fetchedAmountMinor} !== verified total ${verifiedTotalMinor}`);
      }

      // 3. Resolve expected payee deterministically from server-side intents/orders -> merchants registry table (INV-2)
      // NEVER parse historical INTENT_RECEIVED audit log payloads. If merchant/payee lookup fails -> fail closed.
      if (!merchantRef) {
        throw new Error(`Order preflight failed: unable to resolve merchant_ref from server-side intent/order record for intent '${intentId}'`);
      }
      const expectedPayee = catalogResolver.getMerchantPayee(merchantRef);
      if (!expectedPayee || !expectedPayee.payeeRef) {
        throw new Error(`Order preflight failed: merchant '${merchantRef}' not found in server payee registry`);
      }
      const expectedPayeeRef = expectedPayee.payeeRef;
      validatedPayeeRef = expectedPayeeRef;

      // payee MUST be present and strictly match expected server payee
      if (!purchaseUnit.payee || !purchaseUnit.payee.email_address) {
        throw new Error('Order preflight failed: missing payee or payee.email_address in purchase unit');
      }
      if (purchaseUnit.payee.email_address !== expectedPayeeRef) {
        throw new Error(`Order preflight failed: payee '${purchaseUnit.payee.email_address}' !== registry '${expectedPayeeRef}'`);
      }

      // 4. Payer binding check (spec.md §3.1)
      if (mandate?.payer_binding?.payer_id) {
        const payerId = fetchedOrder.payer?.payer_id;
        if (!payerId || payerId !== mandate.payer_binding.payer_id) {
          throw new Error(`Order preflight failed: payer_id '${payerId}' !== bound payer '${mandate.payer_binding.payer_id}'`);
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      withImmediateTransaction(db, () => {
        mandateService.releaseReservation(intentId, `Preflight validation failed: ${errorMsg}`);
        appendAuditEvent(db, {
          actor: 'control_plane',
          type: 'ORDER_PREFLIGHT_FAILED',
          ref: intentId,
          payload: { error: errorMsg, order_id: targetOrderId, reason: 'PREFLIGHT_VALIDATION_FAILED' },
          ts: now,
        });
        db.prepare(
          "UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'PREFLIGHT_VALIDATION_FAILED', updated_at = ? WHERE intent_id = ?",
        ).run(now, intentId);
      });
      return {
        intentId,
        orderId: targetOrderId,
        status: 'FAILED',
        refusalReason: 'PREFLIGHT_VALIDATION_FAILED',
      };
    }

    if (!validatedPayeeRef) {
      throw new Error(`Order preflight failed: missing validated payee_ref for merchant '${merchantRef}'`);
    }

    // STEP C: Capture Execution with Deterministic Request-Id (FR-14, FR-37, AC-14)
    const captureRequestId = generatePayPalRequestId(intentId, 'capture_order');
    let captureId: string;

    if (fetchedOrder.status === 'COMPLETED') {
      // Order is already COMPLETED on PayPal (reconciliation recovery)
      // Extract authentic capture ID strictly from purchase_units[0].payments.captures[0].id (NO fallbacks)
      const authenticCaptureId = fetchedOrder.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      if (!authenticCaptureId) {
        withImmediateTransaction(db, () => {
          mandateService.releaseReservation(intentId, 'COMPLETED order has no authentic capture ID in purchase_units[0].payments.captures[0].id');
          appendAuditEvent(db, {
            actor: 'control_plane',
            type: 'ORDER_FAILED',
            ref: intentId,
            payload: { error: 'COMPLETED order missing authentic capture ID', order_id: targetOrderId },
            ts: now,
          });
          db.prepare(
            "UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'MISSING_AUTHENTIC_CAPTURE_ID', updated_at = ? WHERE intent_id = ?",
          ).run(now, intentId);
        });
        return {
          intentId,
          orderId: targetOrderId,
          status: 'FAILED',
          refusalReason: 'MISSING_AUTHENTIC_CAPTURE_ID',
        };
      }
      captureId = authenticCaptureId;
      captureExecutedOnPayPal = true;
    } else {
      try {
        const captureResponse = await withExponentialBackoff(
          async () => payPalClient.captureOrder(targetOrderId, captureRequestId),
          params.retryConfig,
        );
        const authenticCaptureId = captureResponse.purchase_units?.[0]?.payments?.captures?.[0]?.id;
        if (!authenticCaptureId) {
          throw new Error('Capture response missing authentic captures[0].id');
        }
        captureId = authenticCaptureId;
        captureExecutedOnPayPal = true;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (/ORDER_ALREADY_CAPTURED/i.test(errMsg)) {
          // FR-37, AC-14: Query GET order, verify reference_id == intent_id and amount/currency, record capture state + audit event if missing
          // Wrapped inside try/catch so exceptions never leave an intent stuck in CAPTURING
          try {
            const reconciledOrder = await payPalClient.getOrder(targetOrderId);
            const pUnit = reconciledOrder.purchase_units?.[0];
            if (!pUnit || !pUnit.reference_id || pUnit.reference_id !== intentId) {
              throw new Error(`Reconciliation mismatch: reference_id '${pUnit?.reference_id}' !== intent '${intentId}'`);
            }
            if (!pUnit.amount || !pUnit.amount.value || !pUnit.amount.currency_code) {
              throw new Error('Reconciliation mismatch: missing amount in reconciled order');
            }
            const expectedCurrency = mandate?.currency ?? 'USD';
            if (pUnit.amount.currency_code !== expectedCurrency) {
              throw new Error(`Reconciliation mismatch: currency '${pUnit.amount.currency_code}' !== '${expectedCurrency}'`);
            }
            const parsedAmountMinor = Math.round(parseFloat(pUnit.amount.value) * 100);
            if (Number.isNaN(parsedAmountMinor) || parsedAmountMinor !== verifiedTotalMinor) {
              throw new Error(`Reconciliation mismatch: amount ${parsedAmountMinor} !== verified total ${verifiedTotalMinor}`);
            }

            // Extract the authentic capture ID strictly from purchase_units[0].payments.captures[0].id.
            // STRICTLY FORBIDDEN: Never use || reconciledOrder.id or || order.id as a fallback for capture_id.
            const authenticId = pUnit.payments?.captures?.[0]?.id;
            if (!authenticId) {
              throw new Error('Reconciliation error: missing authentic captures[0].id in reconciled order');
            }
            captureId = authenticId;
            captureExecutedOnPayPal = true;
          } catch (recErr: unknown) {
            const recMsg = recErr instanceof Error ? recErr.message : String(recErr);
            withImmediateTransaction(db, () => {
              mandateService.releaseReservation(intentId, `Reconciliation failed: ${recMsg}`);
              appendAuditEvent(db, {
                actor: 'control_plane',
                type: 'ORDER_FAILED',
                ref: intentId,
                payload: { error: recMsg, request_id: captureRequestId, stage: 'reconciliation' },
                ts: now,
              });
              db.prepare(
                "UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'RECONCILIATION_FAILED', updated_at = ? WHERE intent_id = ?",
              ).run(now, intentId);
            });
            return {
              intentId,
              orderId: targetOrderId,
              status: 'FAILED',
              refusalReason: 'RECONCILIATION_FAILED',
            };
          }
        } else {
          withImmediateTransaction(db, () => {
            mandateService.releaseReservation(intentId, `PayPal capture failed: ${errMsg}`);
            appendAuditEvent(db, {
              actor: 'control_plane',
              type: 'ORDER_FAILED',
              ref: intentId,
              payload: { error: errMsg, request_id: captureRequestId, stage: 'capture' },
              ts: now,
            });
            db.prepare(
              "UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'CAPTURE_FAILED', updated_at = ? WHERE intent_id = ?",
            ).run(now, intentId);
          });
          return {
            intentId,
            orderId: targetOrderId,
            status: 'FAILED',
            refusalReason: 'CAPTURE_FAILED',
          };
        }
      }
    }

    // STEP D: Atomic Settlement & Audit Logging (INV-8, INV-9)
    withImmediateTransaction(db, () => {
      mandateService.captureReservation(intentId, verifiedTotalMinor);

      const existingAudit = db
        .prepare("SELECT seq FROM audit_events WHERE ref = ? AND type = 'ORDER_CAPTURED'")
        .get(intentId) as { seq: number } | undefined;

      if (!existingAudit) {
        appendAuditEvent(db, {
          actor: 'control_plane',
          type: 'ORDER_CAPTURED',
          ref: intentId,
          payload: {
            order_id: targetOrderId,
            capture_id: captureId,
            amount_minor: verifiedTotalMinor,
            currency: mandate?.currency ?? 'USD',
            payee_ref: validatedPayeeRef,
            status: 'COMPLETED',
            request_id: captureRequestId,
          },
          ts: now,
        });
      }

      db.prepare(`
        UPDATE executed_intents
        SET status = 'CAPTURED', order_id = ?, capture_id = ?, refusal_reason = NULL, updated_at = ?
        WHERE intent_id = ?
      `).run(targetOrderId, captureId, now, intentId);
    });

    return {
      intentId,
      orderId: targetOrderId,
      captureId,
      status: 'CAPTURED',
    };
  } catch (unhandledErr: unknown) {
    const unhandledMsg = unhandledErr instanceof Error ? unhandledErr.message : String(unhandledErr);

    // Temuan 5 & FR-37: If PayPal capture already succeeded, money was charged!
    // Do NOT release reservation or mark FAILED on DB error in Step D.
    // Keep intent in CAPTURING and reservation in HELD so startup reconciliation settles it cleanly.
    if (captureExecutedOnPayPal) {
      return {
        intentId,
        orderId: targetOrderId,
        status: 'CAPTURING',
        refusalReason: `STEP_D_DB_FAILURE: ${unhandledMsg}`,
      };
    }

    // Prevent Stuck CAPTURING States:
    // If ANY unhandled error escapes prior to PayPal capture execution, ensure intent does not remain stranded in CAPTURING.
    withImmediateTransaction(db, () => {
      const cur = db
        .prepare('SELECT status FROM executed_intents WHERE intent_id = ?')
        .get(intentId) as { status: string } | undefined;
      if (cur && cur.status === 'CAPTURING') {
        mandateService.releaseReservation(intentId, `Unhandled error during capture: ${unhandledMsg}`);
        appendAuditEvent(db, {
          actor: 'control_plane',
          type: 'ORDER_CAPTURE_FAILED',
          ref: intentId,
          payload: { error: unhandledMsg, stage: 'capturing_abort' },
          ts: now,
        });
        db.prepare(
          "UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'CAPTURE_FAILED', updated_at = ? WHERE intent_id = ?",
        ).run(now, intentId);
      }
    });
    return {
      intentId,
      orderId: targetOrderId,
      status: 'FAILED',
      refusalReason: `CAPTURE_FAILED: ${unhandledMsg}`,
    };
  }
}

/**
 * Startup Reconcile for in-flight CAPTURING intents (FR-37, crash-after-capture recovery).
 */
export async function reconcileCapturingIntents(params: {
  db: DatabaseConnection;
  payPalClient: PayPalClient;
  mandateService: MandateService;
  catalogResolver: StoreCatalogResolver;
  now?: string | undefined;
}): Promise<string[]> {
  const { db, payPalClient, mandateService, catalogResolver } = params;
  initExecutorTables(db);

  const rows = db
    .prepare("SELECT intent_id FROM executed_intents WHERE status = 'CAPTURING'")
    .all() as Array<{ intent_id: string }>;

  const reconciled: string[] = [];
  for (const row of rows) {
    const res = await captureApprovedOrder({
      intentId: row.intent_id,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      now: params.now,
    });
    if (res.status === 'CAPTURED') {
      reconciled.push(row.intent_id);
    }
  }
  return reconciled;
}

export interface PollOrderStatusParams {
  intentId: string;
  orderId: string;
  payPalClient: PayPalClient;
  mandateService: MandateService;
  catalogResolver?: StoreCatalogResolver | undefined;
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
 * Routes through the authoritative captureApprovedOrder function when order is approved or completed.
 */
export async function pollOrderStatus(params: PollOrderStatusParams): Promise<PollOrderStatusResult> {
  const { intentId, orderId, payPalClient, mandateService, db } = params;
  const now = params.now ?? new Date().toISOString();

  initExecutorTables(db);
  const order = await payPalClient.getOrder(orderId);

  let reconciled = false;
  let settled = false;

  if (order.status === 'APPROVED' || order.status === 'COMPLETED') {
    const defaultCatalogResolver: StoreCatalogResolver = params.catalogResolver ?? {
      getMerchantPayee: () => null,
      getItem: () => null,
    };
    const capRes = await captureApprovedOrder({
      intentId,
      payPalClient,
      mandateService,
      catalogResolver: defaultCatalogResolver,
      db,
      now,
    });
    if (capRes.status === 'CAPTURED') {
      reconciled = true;
      settled = true;
      appendAuditEvent(db, {
        actor: 'control_plane',
        type: 'POLLING_RECONCILED',
        ref: intentId,
        payload: {
          order_id: orderId,
          paypal_status: order.status,
          reconciled_to: 'CAPTURED',
          capture_id: capRes.captureId,
        },
        ts: now,
      });
    }
  } else if (order.status === 'VOIDED') {
    withImmediateTransaction(db, () => {
      mandateService.releaseReservation(intentId, 'PayPal order voided detected via polling');
      db.prepare("UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'ORDER_VOIDED', updated_at = ? WHERE intent_id = ?").run(
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
  status: 'CAPTURED' | 'FAILED' | 'APPROVED' | 'AWAITING_PAYER_APPROVAL' | 'EXPIRED' | 'CAPTURING';
  orderId?: string | undefined;
  captureId?: string | undefined;
  approveUrl?: string | undefined;
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

  if (row.status === 'EXPIRED') {
    return {
      intentId,
      mandateId: row.mandate_id,
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason: 'STEP_UP_TIMEOUT',
      auditValid: true,
    };
  }

  // Lazy check on step-up timeout
  if (row.expires_at && isExpiredEpoch(row.expires_at, now)) {
    const res = mandateService.getReservation(intentId);
    if (res && res.state === 'HELD') {
      mandateService.releaseReservation(intentId, 'Step-up approval timeout exceeded');
    }
    db.prepare("UPDATE executed_intents SET status = 'EXPIRED', refusal_reason = 'STEP_UP_TIMEOUT', updated_at = ? WHERE intent_id = ?").run(
      now,
      intentId,
    );
    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'INTENT_EXPIRED',
      ref: intentId,
      payload: {
        intent_id: intentId,
        order_id: null,
        expires_at: row.expires_at,
        expired_at: now,
        reason: 'STEP_UP_TIMEOUT',
      },
      ts: now,
    });
    const vRes = verifyAuditLedger(db);
    return {
      intentId,
      mandateId: row.mandate_id,
      verdict: 'DENY',
      status: 'FAILED',
      refusalReason: 'STEP_UP_TIMEOUT',
      auditValid: vRes.valid,
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

  // Priority 1: Prevent Order Substitution Vulnerability.
  // The executor strictly reads targetOrderId from database (row.order_id), never from client input.
  let targetOrderId = row.order_id;

  if (!targetOrderId) {
    let orderResponse: PayPalOrderResponse;
    try {
      orderResponse = await createMandatePayPalOrder({
        payPalClient,
        intentId,
        currency: proposal.currency,
        totalMinor: verifiedTotalMinor,
        items: orderItems,
        payeeRef: payee.payeeRef, // Strictly from server registry (INV-2)
        requestId: createRequestId,
        retryConfig: params.retryConfig,
      });
      targetOrderId = orderResponse.id;

      appendAuditEvent(db, {
        actor: 'control_plane',
        type: 'ORDER_CREATED',
        ref: intentId,
        payload: {
          order_id: targetOrderId,
          status: orderResponse.status,
          intent: orderResponse.intent,
          amount_minor: verifiedTotalMinor,
          currency: proposal.currency,
          payee_ref: payee.payeeRef,
          request_id: createRequestId,
        },
        ts: now,
      });
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
    const approveUrl = orderResponse.links?.find((l) => l.rel === 'approve')?.href;
    const timeoutSeconds = freshMandate.payer_approval_timeout_seconds ?? 900;
    const expiresAt = new Date(new Date(now).getTime() + timeoutSeconds * 1000).toISOString();

    db.prepare(`
      UPDATE executed_intents
      SET status = 'AWAITING_PAYER_APPROVAL', order_id = ?, approve_url = ?, expires_at = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(targetOrderId, approveUrl ?? null, expiresAt, now, intentId);

    db.prepare(`
      INSERT OR REPLACE INTO orders (order_id, intent_id, merchant_ref, payee_ref, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(targetOrderId, intentId, proposal.merchant_ref, payee.payeeRef, now);

    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'AWAITING_PAYER_APPROVAL',
      ref: intentId,
      payload: {
        order_id: targetOrderId,
        status: 'CREATED',
        approve_url: approveUrl,
        expires_at: expiresAt,
      },
      ts: now,
    });

    const vRes = verifyAuditLedger(db);
    return {
      intentId,
      mandateId: proposal.mandate_id,
      verdict: 'ALLOW',
      status: 'AWAITING_PAYER_APPROVAL',
      orderId: targetOrderId,
      approveUrl,
      auditValid: vRes.valid,
    };
  }

  // If order was already created, route capture attempt through the authoritative captureApprovedOrder function (Guardrail 2)
  const capResult = await captureApprovedOrder({
    intentId,
    payPalClient,
    mandateService,
    catalogResolver,
    db,
    now,
    retryConfig: params.retryConfig,
  });

  const finalAudit = verifyAuditLedger(db);
  return {
    intentId,
    mandateId: proposal.mandate_id,
    verdict: 'ALLOW',
    status: capResult.status,
    orderId: capResult.orderId,
    captureId: capResult.captureId,
    refusalReason: capResult.refusalReason,
    auditValid: finalAudit.valid,
  };
}
