import fastify, { type FastifyInstance } from 'fastify';
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
import { MandateService } from './mandate-service.js';
import {
  executeGoldenPath,
  executeApprovedStepUp,
  initExecutorTables,
  type StoreCatalogResolver,
} from './executor.js';

export interface ServerOptions {
  db: DatabaseConnection;
  mandateService: MandateService;
  catalogResolver: StoreCatalogResolver;
  payPalClient: PayPalClient;
  hmacKey: string;
  webhookId?: string | undefined;
  logger?: boolean | undefined;
  now?: (() => string) | undefined;
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
  // Intent Status Lookup (FR-9, FR-10)
  // --------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/intents/:id', async (request, reply) => {
    const { id } = request.params;
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
      decision,
      created_at: row.created_at,
      updated_at: row.updated_at,
      links,
    });
  });

  // --------------------------------------------------------------------------
  // Human Step-Up Approval (FR-16, FR-18, FR-28, FR-29, AC-9)
  // --------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body?: { expected_payload_hash?: string };
  }>(
    '/v1/intents/:id/approve',
    async (request, reply) => {
      const { id } = request.params;
      const expectedPayloadHash = request.body?.expected_payload_hash;

      const row = db
        .prepare('SELECT * FROM executed_intents WHERE intent_id = ?')
        .get(id) as { intent_id: string; verdict: string; status: string } | undefined;

      if (!row) {
        return reply.code(404).send({
          error: 'INTENT_NOT_FOUND',
          message: `Intent '${id}' not found for approval`,
        });
      }

      if (row.verdict !== 'STEP_UP') {
        return reply.code(400).send({
          error: 'INVALID_VERDICT',
          message: `Intent '${id}' cannot be approved because verdict is '${row.verdict}' (expected 'STEP_UP')`,
        });
      }

      if (row.status === 'CAPTURED') {
        return reply.code(200).send({
          status: 'CAPTURED',
          intent_id: id,
          message: 'Intent has already been approved and captured',
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
        now: getNow(),
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
    },
  );

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
      reason: result.reason ?? null,
    };
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
        if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
          if (intentRow.status !== 'CAPTURED') {
            const res = db
              .prepare('SELECT amount_minor FROM reservations WHERE intent_id = ?')
              .get(customId) as { amount_minor: number } | undefined;
            if (res) {
              mandateService.captureReservation(customId, res.amount_minor);
            }
            db.prepare(
              "UPDATE executed_intents SET status = 'CAPTURED', updated_at = ? WHERE intent_id = ?",
            ).run(nowTs, customId);
          }
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
