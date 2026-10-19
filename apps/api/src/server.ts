import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import {
  type DatabaseConnection,
  appendAuditEvent,
  verifyAuditLedger,
} from '@mandatepay/audit';
import {
  PurchaseIntentProposalSchema,
  type PurchaseIntentProposal,
} from '@mandatepay/schemas';
import { PayPalClient } from '@mandatepay/paypal';
import { MandateService, withReadTransaction } from './mandate-service.js';
import {
  executeGoldenPath,
  executeApprovedStepUp,
  captureApprovedOrder,
  checkAndExpireIntent,
  sweepExpiredIntents,
  initExecutorTables,
  type StoreCatalogResolver,
} from './executor.js';

export interface ServerOptions {
  db: DatabaseConnection;
  mandateService: MandateService;
  catalogResolver: StoreCatalogResolver;
  payPalClient: PayPalClient;
  hmacKey: string;
  ownerToken?: string | undefined;
  agentToken?: string | undefined;
  webhookId?: string | undefined;
  logger?: boolean | undefined;
  now?: (() => string) | undefined;
}

/**
 * Constant-time string equality check to prevent timing side-channel attacks (INV-4).
 */
export function safeTokenCompare(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const hashProvided = createHash('sha256').update(provided).digest();
  const hashExpected = createHash('sha256').update(expected).digest();
  return timingSafeEqual(hashProvided, hashExpected);
}

/**
 * Extracts bearer token strictly from 'Authorization: Bearer <token>' header format.
 * Returns null if missing, empty, or not starting with 'Bearer '.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match || !match[1]) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Enforces strict owner token allowlist on all human authorization endpoints (FR-18, FR-31, INV-4).
 * - Missing/non-Bearer/invalid token => 401 Unauthorized
 * - Agent token attempting human action => 403 Forbidden
 * - Matching owner token => allowed
 * All fallback defaults are strictly removed.
 */
export function authenticateOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  tokens: { ownerToken?: string | undefined; agentToken?: string | undefined },
): boolean {
  const authHeader = request.headers['authorization'];
  const token = extractBearerToken(authHeader);

  if (!token) {
    reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authorization header with Bearer token is required (INV-4, FR-18)',
      statusCode: 401,
    });
    return false;
  }

  const effectiveAgentToken = tokens.agentToken ?? process.env['AGENT_TOKEN'];
  const effectiveOwnerToken = tokens.ownerToken ?? process.env['OWNER_TOKEN'];

  // Explicitly reject agent tokens with 403 Forbidden
  if (effectiveAgentToken && safeTokenCompare(token, effectiveAgentToken)) {
    reply.code(403).send({
      error: 'FORBIDDEN',
      message: 'Agent tokens are forbidden from calling human authorization endpoints (FR-18, FR-31, INV-4)',
      statusCode: 403,
    });
    return false;
  }

  // Allowlist: strictly verify matching owner token via timingSafeEqual
  if (!effectiveOwnerToken || !safeTokenCompare(token, effectiveOwnerToken)) {
    reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Invalid owner authorization token (INV-4, FR-18)',
      statusCode: 401,
    });
    return false;
  }

  return true;
}

/**
 * Builds and configures the Control Plane Fastify HTTP Server (specs/spec.md §2, tech.md §3, §4, tasks.md T-014).
 * Exposes:
 * - GET  /health: Health check probe
 * - POST /v1/intents/propose: Validates proposal via Zod, policy engine evaluation, reservation, and execution
 * - GET  /v1/intents/:id: Retrieves intent status, decision, and step-up links
 * - POST /v1/intents/:id/approve: Human approval endpoint with cryptographic payload-hash binding (FR-18, FR-28)
 * - GET  /v1/mandates/:id: Active mandate details and budget tracking statistics
 * - GET  /v1/audit/events: Paginated audit ledger event explorer
 * - GET  /v1/audit/verify: Runs tamper verification across the SHA-256 hash chain (FR-22)
 * - POST /v1/webhooks/paypal: PayPal webhook verification & asynchronous reconciliation (FR-15, tech.md §4.2)
 */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { db, mandateService, catalogResolver, payPalClient, hmacKey } = options;
  const getNow = options.now ?? (() => new Date().toISOString());

  // Enforce OWNER_TOKEN configuration at startup (INV-4, FR-18)
  const isDemoMode = process.env['DEMO_MODE'] === 'true' || process.env['DEMO_MODE'] === '1';
  let resolvedOwnerToken = options.ownerToken ?? process.env['OWNER_TOKEN'];
  const resolvedAgentToken = options.agentToken ?? process.env['AGENT_TOKEN'];

  if (!resolvedOwnerToken || resolvedOwnerToken.trim().length < 32) {
    if (isDemoMode) {
      resolvedOwnerToken = createHash('sha256').update(randomBytes(32)).digest('hex');
      if (!process.env['CI'] && process.env['NODE_ENV'] !== 'test') {
        console.log(`[DEMO_MODE] Generated ephemeral OWNER_TOKEN (${resolvedOwnerToken.length} chars): ${resolvedOwnerToken}`);
      }
    } else {
      throw new Error(
        'Server startup aborted: OWNER_TOKEN must be configured and be at least 32 characters long (INV-4, FR-18). Set DEMO_MODE=true for ephemeral testing.'
      );
    }
  }

  initExecutorTables(db);

  const app = fastify({
    logger: options.logger ?? false,
  });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Global uniform error handling
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const err = error as { statusCode?: number; name?: string; message?: string };
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    return reply.code(statusCode).send({
      error: err.name || 'InternalServerError',
      message: err.message || 'An unexpected error occurred',
      statusCode,
    });
  });

  // --------------------------------------------------------------------------
  // Health Probe (tech.md §7)
  // --------------------------------------------------------------------------
  app.get('/health', async () => {
    return {
      status: 'OK',
      timestamp: getNow(),
    };
  });

  // --------------------------------------------------------------------------
  // Purchase Intent Proposal (FR-7, FR-8, FR-10, FR-11, FR-26)
  // --------------------------------------------------------------------------
  app.post('/v1/intents/propose', async (request, reply) => {
    const rawBody = request.body;
    if (!rawBody || typeof rawBody !== 'object') {
      return reply.code(400).send({
        error: 'MALFORMED',
        message: 'Request body must be a JSON object',
      });
    }

    const parseResult = PurchaseIntentProposalSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'MALFORMED',
        message: 'Invalid purchase intent proposal schema',
        details: parseResult.error.format(),
      });
    }

    const proposal: PurchaseIntentProposal = parseResult.data;

    const result = await executeGoldenPath({
      proposal,
      rawJson: JSON.stringify(rawBody),
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey,
      now: getNow(),
    });

    if (result.verdict === 'ALLOW') {
      return reply.code(200).send({
        verdict: 'ALLOW',
        intent_id: result.intentId,
        status: result.status,
        order_id: result.orderId,
        capture_id: result.captureId,
        approve_url: result.approveUrl,
        decision: result.decision,
      });
    }

    if (result.verdict === 'STEP_UP') {
      const approvalLink = `/v1/intents/${result.intentId}/approve`;
      return reply.code(200).send({
        verdict: 'STEP_UP',
        intent_id: result.intentId,
        status: result.status,
        decision: result.decision,
        refusal_reason: result.refusalReason,
        links: [
          {
            rel: 'approve',
            href: approvalLink,
            method: 'POST',
            description: 'Human authorization endpoint for step-up purchases',
          },
        ],
      });
    }

    return reply.code(200).send({
      verdict: 'DENY',
      intent_id: result.intentId,
      status: result.status,
      refusal_reason: result.refusalReason,
      decision: result.decision,
    });
  });

  // --------------------------------------------------------------------------
  // Intent Status Lookup (FR-9, FR-10, FR-34)
  // --------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/intents/:id', async (request, reply) => {
    const { id } = request.params;
    const nowTs = getNow();

    // Lazy check on approval timeout (FR-34, AC-12)
    checkAndExpireIntent(db, mandateService, id, nowTs);

    const row = db
      .prepare('SELECT * FROM executed_intents WHERE intent_id = ?')
      .get(id) as
      | {
        intent_id: string;
        mandate_id: string;
        verdict: string;
        decision_json: string;
        status: string;
        order_id: string | null;
        capture_id: string | null;
        payload_hash: string | null;
        refusal_reason: string | null;
        approve_url: string | null;
        expires_at: string | null;
        created_at: string;
        updated_at: string;
      }
      | undefined;

    if (!row) {
      return reply.code(404).send({
        error: 'INTENT_NOT_FOUND',
        message: `Purchase intent with id '${id}' was not found`,
      });
    }

    const decision = JSON.parse(row.decision_json);
    const links: Array<{ rel: string; href: string; method: string; description?: string }> = [];

    if (row.verdict === 'STEP_UP' && row.status !== 'CAPTURED') {
      links.push({
        rel: 'approve',
        href: `/v1/intents/${id}/approve`,
        method: 'POST',
        description: 'Human approval endpoint for step-up purchase',
      });
      links.push({
        rel: 'reject',
        href: `/v1/intents/${id}/reject`,
        method: 'POST',
        description: 'Human rejection endpoint for step-up purchase',
      });
    }

    if (row.status === 'AWAITING_PAYER_APPROVAL' && row.approve_url) {
      links.push({
        rel: 'paypal_approve',
        href: row.approve_url,
        method: 'GET',
        description: 'PayPal sandbox buyer approval URL',
      });
    }

    return reply.code(200).send({
      intent_id: row.intent_id,
      mandate_id: row.mandate_id,
      verdict: row.verdict,
      status: row.status,
      order_id: row.order_id,
      capture_id: row.capture_id,
      payload_hash: row.payload_hash,
      refusal_reason: row.refusal_reason,
      approve_url: row.approve_url,
      expires_at: row.expires_at,
      decision,
      created_at: row.created_at,
      updated_at: row.updated_at,
      links,
    });
  });

  // --------------------------------------------------------------------------
  // Human Approval / Capture Trigger (FR-16, FR-18, FR-28, FR-29, FR-34, AC-9, AC-12)
  // --------------------------------------------------------------------------
  const handleApprove = async (
    id: string,
    expectedPayloadHash: string | undefined,
    request: FastifyRequest | undefined,
    reply: FastifyReply,
  ) => {
    // Enforce FR-18, FR-31, INV-4: Strict owner allowlist via timingSafeEqual
    if (!request || !authenticateOwner(request, reply, { ownerToken: resolvedOwnerToken, agentToken: resolvedAgentToken })) {
      return;
    }

    const nowTs = getNow();

    // Lazy check on approval timeout (FR-34, AC-12)
    checkAndExpireIntent(db, mandateService, id, nowTs);

    const row = db
      .prepare('SELECT * FROM executed_intents WHERE intent_id = ?')
      .get(id) as {
        intent_id: string;
        verdict: string;
        status: string;
        order_id: string | null;
        capture_id: string | null;
      } | undefined;

    if (!row) {
      return reply.code(404).send({
        error: 'INTENT_NOT_FOUND',
        message: `Intent '${id}' not found for approval`,
      });
    }

    if (row.status === 'EXPIRED') {
      const errCode = row.verdict === 'STEP_UP' ? 'STEP_UP_TIMEOUT' : 'PAYER_APPROVAL_TIMEOUT';
      return reply.code(422).send({
        error: errCode,
        message: `Approval rejected: intent has expired (${errCode}) and reservation was released (FR-34)`,
        refusal_reason: errCode,
      });
    }

    if (row.status === 'CAPTURED') {
      return reply.code(200).send({
        status: 'CAPTURED',
        intent_id: id,
        order_id: row.order_id,
        capture_id: row.capture_id,
        message: 'Intent has already been captured',
      });
    }

    // If order was already created and is awaiting payer approval or capturing, route through captureApprovedOrder
    if (row.status === 'AWAITING_PAYER_APPROVAL' || row.status === 'CAPTURING') {
      const captureResult = await captureApprovedOrder({
        intentId: id,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: nowTs,
      });

      if (captureResult.status === 'EXPIRED') {
        return reply.code(422).send({
          error: 'PAYER_APPROVAL_TIMEOUT',
          message: 'Approval rejected: intent has expired and reservation was released (FR-34)',
          refusal_reason: 'PAYER_APPROVAL_TIMEOUT',
        });
      }

      if (captureResult.status === 'AWAITING_PAYER_APPROVAL') {
        return reply.code(200).send({
          status: 'AWAITING_PAYER_APPROVAL',
          intent_id: id,
          order_id: captureResult.orderId,
          message: 'Order created on PayPal; awaiting payer approval before capture',
        });
      }

      if (captureResult.status === 'FAILED') {
        return reply.code(400).send({
          error: captureResult.refusalReason ?? 'CAPTURE_FAILED',
          message: `Capture failed: ${captureResult.refusalReason}`,
          refusal_reason: captureResult.refusalReason,
        });
      }

      return reply.code(200).send({
        status: 'CAPTURED',
        intent_id: id,
        order_id: captureResult.orderId,
        capture_id: captureResult.captureId,
      });
    }

    if (row.verdict !== 'STEP_UP') {
      return reply.code(400).send({
        error: 'INVALID_VERDICT',
        message: `Intent '${id}' cannot be approved because verdict is '${row.verdict}' (expected 'STEP_UP')`,
      });
    }

    // FR-28 & Rule §2.1: Human approval of a STEP_UP intent MUST supply expected_payload_hash
    if (!expectedPayloadHash || expectedPayloadHash.trim() === '') {
      return reply.code(422).send({
        error: 'PAYLOAD_HASH_REQUIRED',
        message: 'Approval rejected: expected_payload_hash is required for STEP_UP approval (FR-28)',
        refusal_reason: 'PAYLOAD_HASH_REQUIRED',
      });
    }

    const result = await executeApprovedStepUp({
      intentId: id,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey,
      expectedPayloadHash,
      now: nowTs,
    });

    if (result.refusalReason === 'PAYLOAD_HASH_MISMATCH') {
      return reply.code(422).send({
        error: 'PAYLOAD_HASH_MISMATCH',
        message: 'Approval rejected: payload hash mismatch (FR-28)',
        refusal_reason: 'PAYLOAD_HASH_MISMATCH',
      });
    }

    if (result.status === 'FAILED') {
      return reply.code(400).send({
        error: result.refusalReason ?? 'APPROVAL_EXECUTION_FAILED',
        message: `Approval execution failed: ${result.refusalReason}`,
        refusal_reason: result.refusalReason,
      });
    }

    if (result.status === 'AWAITING_PAYER_APPROVAL') {
      return reply.code(200).send({
        status: 'AWAITING_PAYER_APPROVAL',
        intent_id: result.intentId,
        order_id: result.orderId,
        approve_url: result.approveUrl,
        message: 'Order created on PayPal; awaiting payer approval before capture',
      });
    }

    return reply.code(200).send({
      status: 'CAPTURED',
      intent_id: result.intentId,
      order_id: result.orderId,
      capture_id: result.captureId,
    });
  };

  app.post<{
    Params: { id: string };
    Body?: { expected_payload_hash?: string };
  }>('/v1/intents/:id/approve', async (request, reply) => {
    return handleApprove(request.params.id, request.body?.expected_payload_hash, request, reply);
  });

  // Strict Capture Route: restricted only to intents that already have an order created (AWAITING_PAYER_APPROVAL / CAPTURING)
  app.post<{
    Params: { id: string };
    Body?: { expected_payload_hash?: string };
  }>('/v1/intents/:id/capture', async (request, reply) => {
    if (!authenticateOwner(request, reply, { ownerToken: resolvedOwnerToken, agentToken: resolvedAgentToken })) {
      return;
    }
    const { id } = request.params;
    const nowTs = getNow();
    checkAndExpireIntent(db, mandateService, id, nowTs);

    const row = db
      .prepare('SELECT status FROM executed_intents WHERE intent_id = ?')
      .get(id) as { status: string } | undefined;

    if (!row) {
      return reply.code(404).send({
        error: 'INTENT_NOT_FOUND',
        message: `Intent '${id}' not found for capture`,
      });
    }

    if (row.status !== 'AWAITING_PAYER_APPROVAL' && row.status !== 'CAPTURING' && row.status !== 'CAPTURED') {
      return reply.code(400).send({
        error: 'INVALID_STATUS',
        message: `Intent '${id}' cannot be captured: status is '${row.status}' (expected 'AWAITING_PAYER_APPROVAL' or 'CAPTURING')`,
      });
    }

    return handleApprove(id, request.body?.expected_payload_hash, request, reply);
  });

  app.get('/v1/approvals', async (request, reply) => {
    if (!authenticateOwner(request, reply, { ownerToken: resolvedOwnerToken, agentToken: resolvedAgentToken })) {
      return;
    }
    const nowTs = getNow();
    sweepExpiredIntents(db, mandateService, nowTs);

    const rows = db
      .prepare(
        `SELECT intent_id, mandate_id, verdict, status, order_id, payload_hash, refusal_reason, approve_url, expires_at, created_at, updated_at
         FROM executed_intents
         WHERE verdict = 'STEP_UP' AND status IN ('APPROVED', 'PENDING_APPROVAL', 'AWAITING_PAYER_APPROVAL')
         ORDER BY created_at ASC`,
      )
      .all();

    return {
      approvals: rows,
      total: rows.length,
    };
  });

  app.post<{
    Params: { id: string };
    Body?: { expected_payload_hash?: string };
  }>('/v1/approvals/:id/approve', async (request, reply) => {
    return handleApprove(request.params.id, request.body?.expected_payload_hash, request, reply);
  });

  // --------------------------------------------------------------------------
  // Human Step-Up Rejection (FR-18, FR-26)
  // --------------------------------------------------------------------------
  const handleReject = async (
    id: string,
    request: FastifyRequest | undefined,
    reply: FastifyReply,
  ) => {
    // Enforce FR-18, FR-31, INV-4: Strict owner allowlist via timingSafeEqual
    if (!request || !authenticateOwner(request, reply, { ownerToken: resolvedOwnerToken, agentToken: resolvedAgentToken })) {
      return;
    }

    const nowTs = getNow();

    const row = db
      .prepare('SELECT * FROM executed_intents WHERE intent_id = ?')
      .get(id) as { intent_id: string; status: string } | undefined;

    if (!row) {
      return reply.code(404).send({
        error: 'INTENT_NOT_FOUND',
        message: `Intent '${id}' not found for rejection`,
      });
    }

    if (row.status === 'CAPTURED') {
      return reply.code(400).send({
        error: 'ALREADY_CAPTURED',
        message: 'Cannot reject an already captured intent',
      });
    }

    mandateService.releaseReservation(id, 'Owner rejected step-up purchase intent');
    db.prepare(
      "UPDATE executed_intents SET status = 'REJECTED', refusal_reason = 'OWNER_REJECTED', updated_at = ? WHERE intent_id = ?",
    ).run(nowTs, id);

    appendAuditEvent(db, {
      actor: 'user',
      type: 'INTENT_REJECTED',
      ref: id,
      payload: {
        intent_id: id,
        reason: 'OWNER_REJECTED',
      },
      ts: nowTs,
    });

    return reply.code(200).send({
      intent_id: id,
      status: 'REJECTED',
      message: 'Intent rejected and reservation released',
    });
  };

  app.post<{ Params: { id: string } }>('/v1/intents/:id/reject', async (request, reply) => {
    return handleReject(request.params.id, request, reply);
  });

  app.post<{ Params: { id: string } }>('/v1/approvals/:id/reject', async (request, reply) => {
    return handleReject(request.params.id, request, reply);
  });

  // --------------------------------------------------------------------------
  // Mandate Inspection & Spend Tracking (FR-1..FR-6, FR-26)
  // --------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/mandates/:id', async (request, reply) => {
    const { id } = request.params;
    const mandate = mandateService.getMandate(id);

    if (!mandate) {
      return reply.code(404).send({
        error: 'MANDATE_NOT_FOUND',
        message: `Mandate with id '${id}' was not found`,
      });
    }

    const spend = mandateService.getSpend(id);
    const committedMinor = spend.captured_minor + spend.reserved_minor;
    const remainingMinor = Math.max(0, mandate.total_budget_minor - committedMinor);

    return reply.code(200).send({
      mandate,
      spend: {
        mandate_id: spend.mandate_id,
        captured_minor: spend.captured_minor,
        reserved_minor: spend.reserved_minor,
        committed_minor: committedMinor,
        remaining_minor: remainingMinor,
        total_budget_minor: mandate.total_budget_minor,
        currency: mandate.currency,
        updated_at: spend.updated_at,
      },
    });
  });

  // --------------------------------------------------------------------------
  // Audit Ledger Explorer (FR-21)
  // --------------------------------------------------------------------------
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      actor?: string;
      type?: string;
      mandate_id?: string;
    };
  }>('/v1/audit/events', async (request, reply) => {
    const query = request.query;
    const limit = Math.min(Math.max(1, Number(query.limit ?? 50) || 50), 200);
    const offset = Math.max(0, Number(query.offset ?? 0) || 0);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.actor) {
      conditions.push('actor = ?');
      params.push(query.actor);
    }
    if (query.type) {
      conditions.push('type = ?');
      params.push(query.type);
    }
    if (query.mandate_id) {
      conditions.push('(ref = ? OR payload LIKE ?)');
      params.push(query.mandate_id, `%"mandate_id":"${query.mandate_id}"%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db
      .prepare(`SELECT count(*) as count FROM audit_events ${whereClause}`)
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `SELECT seq, ts, actor, type, ref, payload, prev_hash, hash
         FROM audit_events ${whereClause}
         ORDER BY seq ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
        seq: number;
        ts: string;
        actor: string;
        type: string;
        ref: string;
        payload: string;
        prev_hash: string;
        hash: string;
      }>;

    const events = rows.map((r) => {
      let parsedPayload: unknown = r.payload;
      try {
        parsedPayload = JSON.parse(r.payload);
      } catch {
        // Fallback for non-JSON string payloads
      }
      return {
        seq: r.seq,
        ts: r.ts,
        actor: r.actor,
        type: r.type,
        ref: r.ref,
        payload: parsedPayload,
        prev_hash: r.prev_hash,
        hash: r.hash,
      };
    });

    return reply.code(200).send({
      events,
      total: countRow.count,
      limit,
      offset,
    });
  });

  // --------------------------------------------------------------------------
  // Audit Ledger Integrity Verification (FR-22, AC-5)
  // --------------------------------------------------------------------------
  app.get('/v1/audit/verify', async () => {
    const result = verifyAuditLedger(db);
    return {
      valid: result.valid,
      count: result.count,
      broken_at_seq: result.brokenAtSeq ?? null,
      broken_seq: result.brokenAtSeq ?? null,
      reason: result.reason ?? null,
    };
  });

  // --------------------------------------------------------------------------
  // Impact Dashboard Summary (Task T-018, spec §2)
  // --------------------------------------------------------------------------
  app.get<{
    Querystring: {
      mandate_id?: string;
    };
  }>('/v1/dashboard/summary', async (request, reply) => {
    const mandateId = request.query.mandate_id || 'mnd_demo_001';
    const nowTs = getNow();

    // Lazy sweep expired intents
    sweepExpiredIntents(db, mandateService, nowTs);

    // GET /v1/dashboard/summary is read-only and polled frequently.
    // Use deferred read transaction (BEGIN DEFERRED / COMMIT) to obtain a consistent WAL snapshot
    // without acquiring exclusive write locks or blocking concurrent intent execution (INV-8, T-018 §2).
    const summary = withReadTransaction(db, () => {
      const mandate = mandateService.getMandate(mandateId);
      if (!mandate) {
        return null;
      }

      const spend = mandateService.getSpend(mandateId);
      const totalBudgetMinor = mandate.total_budget_minor;
      const capturedMinor = spend.captured_minor;
      const reservedMinor = spend.reserved_minor;
      const remainingMinor = Math.max(0, totalBudgetMinor - capturedMinor - reservedMinor);

      // Blocked intents (verdict = 'DENY')
      const denyRows = db
        .prepare(
          `SELECT intent_id, proposal_json
           FROM executed_intents
           WHERE mandate_id = ? AND verdict = 'DENY'`,
        )
        .all(mandateId) as Array<{ intent_id: string; proposal_json: string | null }>;

      let attemptedTotalMinor = 0;
      let unknownAmountCount = 0;

      for (const row of denyRows) {
        let claimedAmount: number | null = null;
        if (row.proposal_json) {
          try {
            const p = JSON.parse(row.proposal_json);
            if (typeof p.claimed_total_minor === 'number' && Number.isFinite(p.claimed_total_minor)) {
              claimedAmount = p.claimed_total_minor;
            }
          } catch {
            // ignore malformed JSON
          }
        }
        if (claimedAmount === null) {
          const auditRow = db
            .prepare(
              "SELECT payload FROM audit_events WHERE ref = ? AND type = 'INTENT_RECEIVED' ORDER BY seq DESC LIMIT 1",
            )
            .get(row.intent_id) as { payload: string } | undefined;
          if (auditRow) {
            try {
              const p = JSON.parse(auditRow.payload);
              if (typeof p.claimed_total_minor === 'number' && Number.isFinite(p.claimed_total_minor)) {
                claimedAmount = p.claimed_total_minor;
              }
            } catch {
              // ignore
            }
          }
        }

        if (claimedAmount !== null) {
          attemptedTotalMinor += claimedAmount;
        } else {
          unknownAmountCount += 1;
        }
      }

      // Derived from the absence of order creation (order_id IS NOT NULL or ORDER_CREATED audit events) for DENY intents (T-018 §2)
      const denyWithOrders = db
        .prepare(
          `SELECT count(*) as count FROM executed_intents
           WHERE mandate_id = ? AND verdict = 'DENY' AND (
             order_id IS NOT NULL OR EXISTS (
               SELECT 1 FROM audit_events a WHERE a.ref = executed_intents.intent_id AND a.type = 'ORDER_CREATED'
             )
           )`,
        )
        .get(mandateId) as { count: number };

      // Verified / captured count
      const capturedRow = db
        .prepare(
          `SELECT count(*) as count
           FROM executed_intents
           WHERE mandate_id = ? AND status = 'CAPTURED'`,
        )
        .get(mandateId) as { count: number };

      // Audit chain status
      const auditResult = verifyAuditLedger(db);
      const lastEvent = db
        .prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1')
        .get() as { seq: number; hash: string } | undefined;

      return {
        mandate: {
          id: mandateId,
          currency: mandate.currency,
          total_budget_minor: totalBudgetMinor,
          captured_minor: capturedMinor,
          reserved_minor: reservedMinor,
          remaining_minor: remainingMinor,
        },
        blocked: {
          count: denyRows.length,
          attempted_total_minor: attemptedTotalMinor,
          unknown_amount_count: unknownAmountCount,
          paypal_calls: denyWithOrders.count,
        },
        verified: {
          count: capturedRow.count,
          captured_total_minor: capturedMinor,
        },
        audit: {
          head_seq: lastEvent ? Number(lastEvent.seq) : 0,
          head_hash: lastEvent ? String(lastEvent.hash) : '0'.repeat(64),
          chain_valid: auditResult.valid,
        },
        generated_at: nowTs,
      };
    });

    if (!summary) {
      return reply.code(404).send({
        error: 'MANDATE_NOT_FOUND',
        message: `Mandate '${mandateId}' was not found`,
      });
    }

    return reply.code(200).send(summary);
  });

  // --------------------------------------------------------------------------
  // PayPal Webhook Receiver (FR-15, FR-32, tech.md §4.2)
  // --------------------------------------------------------------------------
  app.post('/v1/webhooks/paypal', async (request, reply) => {
    const webhookId = options.webhookId ?? process.env['PAYPAL_WEBHOOK_ID'] ?? 'WH-MOCK-ID';
    const authAlgo = request.headers['paypal-auth-algo'] as string | undefined;
    const certUrl = request.headers['paypal-cert-url'] as string | undefined;
    const transmissionId = request.headers['paypal-transmission-id'] as string | undefined;
    const transmissionSig = request.headers['paypal-transmission-sig'] as string | undefined;
    const transmissionTime = request.headers['paypal-transmission-time'] as string | undefined;
    const webhookEvent = (request.body as Record<string, unknown> | undefined) ?? {};

    // Validate signature if PayPal verification headers are present
    if (authAlgo && certUrl && transmissionId && transmissionSig && transmissionTime) {
      try {
        const verifyRes = await payPalClient.verifyWebhookSignature({
          authAlgo,
          certUrl,
          transmissionId,
          transmissionSig,
          transmissionTime,
          webhookId,
          webhookEvent,
        });

        if (verifyRes.verification_status !== 'SUCCESS') {
          return reply.code(400).send({
            error: 'INVALID_WEBHOOK_SIGNATURE',
            message: 'PayPal webhook signature verification failed',
            verification_status: verifyRes.verification_status,
          });
        }
      } catch (err: unknown) {
        return reply.code(400).send({
          error: 'WEBHOOK_VERIFICATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const nowTs = getNow();
    const eventId = String(webhookEvent['id'] ?? transmissionId ?? `wh_${Date.now()}`);

    appendAuditEvent(db, {
      actor: 'paypal',
      type: 'WEBHOOK_RECEIVED',
      ref: eventId,
      payload: webhookEvent,
      ts: nowTs,
    });

    const eventType = String(webhookEvent['event_type'] ?? '');
    const resource = (webhookEvent['resource'] as Record<string, unknown> | undefined) ?? {};
    const customId = String(
      resource['custom_id'] ?? resource['invoice_id'] ?? resource['reference_id'] ?? '',
    );

    if (customId) {
      const intentRow = db
        .prepare('SELECT intent_id, status FROM executed_intents WHERE intent_id = ?')
        .get(customId) as { intent_id: string; status: string } | undefined;

      if (intentRow) {
        if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'CHECKOUT.ORDER.APPROVED') {
          await captureApprovedOrder({
            intentId: customId,
            payPalClient,
            mandateService,
            catalogResolver,
            db,
            now: nowTs,
          });
        } else if (eventType === 'PAYMENT.CAPTURE.DENIED') {
          mandateService.releaseReservation(
            customId,
            'Payment capture denied by PayPal webhook notification',
          );
          db.prepare(
            "UPDATE executed_intents SET status = 'FAILED', refusal_reason = 'CAPTURE_DENIED', updated_at = ?",
          ).run(nowTs, customId);
        }
      }
    }

    return reply.code(200).send({
      status: 'PROCESSED',
      event_type: eventType,
      id: eventId,
    });
  });

  return app;
}
