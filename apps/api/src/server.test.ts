import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { openDb, type DatabaseConnection } from '@mandatepay/audit';
import { PayPalClient } from '@mandatepay/paypal';
import type { PurchaseIntentProposal } from '@mandatepay/schemas';
import {
  MandateService,
  initMandateTables,
  initExecutorTables,
  type StoreCatalogResolver,
} from './index.js';
import { buildServer } from './server.js';

const TEST_HMAC_KEY = 'test_server_hmac_secret_32bytes_long!';
const FIXED_NOW = '2026-10-20T10:00:00Z';

interface SeededMerchant {
  id: string;
  name: string;
  paypal_payee_ref: string;
  base_url: string;
}

interface SeededItem {
  sku: string;
  merchant_id: string;
  name: string;
  category: string;
  price_minor: number;
}

const MERCHANTS: SeededMerchant[] = [
  {
    id: 'mrc_demo_store',
    name: 'Demo Store',
    paypal_payee_ref: 'merchant@demo-store.local',
    base_url: 'https://demo-store.local',
  },
];

const CATALOG: SeededItem[] = [
  {
    sku: 'SKU-PEN-PACK',
    merchant_id: 'mrc_demo_store',
    name: 'Gel Pen 10-Pack',
    category: 'office_supplies',
    price_minor: 900,
  },
  {
    sku: 'SKU-DESK-LAMP',
    merchant_id: 'mrc_demo_store',
    name: 'Architect LED Desk Lamp',
    category: 'office_supplies',
    price_minor: 4500,
  },
  {
    sku: 'SKU-STAND-DESK',
    merchant_id: 'mrc_demo_store',
    name: 'Motorized Standing Desk',
    category: 'office_supplies',
    price_minor: 32000,
  },
];

function setupTestDb(db: DatabaseConnection) {
  initMandateTables(db);
  initExecutorTables(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      paypal_payee_ref TEXT NOT NULL,
      base_url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_items (
      sku TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_minor INTEGER NOT NULL,
      PRIMARY KEY (sku, merchant_id)
    );
  `);

  for (const m of MERCHANTS) {
    db.prepare('INSERT OR REPLACE INTO merchants VALUES (?, ?, ?, ?)').run(
      m.id,
      m.name,
      m.paypal_payee_ref,
      m.base_url,
    );
  }

  for (const item of CATALOG) {
    db.prepare('INSERT OR REPLACE INTO catalog_items VALUES (?, ?, ?, ?, ?)').run(
      item.sku,
      item.merchant_id,
      item.name,
      item.category,
      item.price_minor,
    );
  }
}

function createTestCatalogResolver(db: DatabaseConnection): StoreCatalogResolver {
  return {
    getMerchantPayee: (ref: string) => {
      const row = db
        .prepare('SELECT id, name, paypal_payee_ref FROM merchants WHERE id = ?')
        .get(ref) as { id: string; name: string; paypal_payee_ref: string } | undefined;
      return row ? { merchantId: row.id, name: row.name, payeeRef: row.paypal_payee_ref } : null;
    },
    getItem: (merchantRef: string, sku: string) => {
      const row = db
        .prepare('SELECT price_minor, name, category FROM catalog_items WHERE merchant_id = ? AND sku = ?')
        .get(merchantRef, sku) as { price_minor: number; name: string; category: string } | undefined;
      return row ? { verified: true, priceMinor: row.price_minor, name: row.name, category: row.category } : null;
    },
  };
}

describe('Fastify HTTP API Server (Task T-014, specs/spec.md §2, tech.md §3, §4)', () => {
  const mandateId = 'mnd_server_test_01';
  let db: DatabaseConnection;
  let mandateService: MandateService;
  let catalogResolver: StoreCatalogResolver;
  let payPalClient: PayPalClient;
  let server: FastifyInstance;
  let orderCallCount = 0;
  let captureCallCount = 0;
  let verifyWebhookCount = 0;
  let webhookVerificationResult: 'SUCCESS' | 'FAILURE' = 'SUCCESS';

  beforeEach(async () => {
    db = openDb(':memory:');
    setupTestDb(db);
    catalogResolver = createTestCatalogResolver(db);
    mandateService = new MandateService(db, TEST_HMAC_KEY, () => FIXED_NOW);

    // Standard mandate matching demo parameters
    mandateService.createDraft({
      mandate_id: mandateId,
      owner_id: 'usr_server_owner',
      agent_id: 'agt_server_shopper',
      currency: 'USD',
      valid_from: '2026-10-20T00:00:00Z',
      valid_until: '2026-10-20T23:59:59Z',
      total_budget_minor: 20000,
      per_txn_limit_minor: 8000,
      auto_approve_limit_minor: 3000,
      max_txns_per_hour: 5,
      allowed_merchants: ['mrc_demo_store'],
      allowed_categories: ['office_supplies'],
      max_items_per_intent: 5,
      max_pending_approvals: 3,
      suspend_after_denies: 5,
      step_up: { channel: 'dashboard', timeout_seconds: 300 },
      risk: { step_up_threshold: 40, deny_threshold: 75 },
      wallet: { type: 'paypal_vault', ref: 'pt_test_vault' },
      created_at: '2026-10-20T00:00:00Z',
    });
    mandateService.activate(mandateId);

    orderCallCount = 0;
    captureCallCount = 0;
    verifyWebhookCount = 0;
    webhookVerificationResult = 'SUCCESS';

    payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_server',
      clientSecret: 'sandbox_client_sec_server',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_server_test', expires_in: 3600 }), {
            status: 200,
          });
        }
        if (urlStr.includes('/v1/notifications/verify-webhook-signature')) {
          verifyWebhookCount++;
          return new Response(
            JSON.stringify({ verification_status: webhookVerificationResult }),
            { status: 200 },
          );
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          if (urlStr.includes('/capture')) {
            captureCallCount++;
            return new Response(JSON.stringify({ id: 'CAPTURE-HTTP-OK', status: 'COMPLETED' }), {
              status: 201,
            });
          }
          orderCallCount++;
          return new Response(
            JSON.stringify({
              id: 'ORDER-HTTP-OK',
              status: 'CREATED',
              links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-HTTP-OK' }],
            }),
            { status: 201 },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    server = await buildServer({
      db,
      mandateService,
      catalogResolver,
      payPalClient,
      hmacKey: TEST_HMAC_KEY,
      webhookId: 'WH-TEST-CONFIGURED-ID',
      now: () => FIXED_NOW,
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  // --------------------------------------------------------------------------
  // 1. Health Probe
  // --------------------------------------------------------------------------
  it('GET /health returns 200 OK with timestamp', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('OK');
    expect(body.timestamp).toBe(FIXED_NOW);
  });

  // --------------------------------------------------------------------------
  // 2. Proposal Validation & HTTP Rejection (400)
  // --------------------------------------------------------------------------
  it('POST /v1/intents/propose rejects malformed proposals with 400 MALFORMED', async () => {
    // Missing required fields
    const resEmpty = await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: {},
    });
    expect(resEmpty.statusCode).toBe(400);
    expect(JSON.parse(resEmpty.body).error).toBe('MALFORMED');

    // Claimed total mismatch
    const resMismatch = await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: {
        intent_id: 'int_bad_total_01',
        mandate_id: mandateId,
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 1200, // Invalid! 1200 != 900
        currency: 'USD',
        user_goal_ref: 'msg_bad',
        rationale: 'Bad claimed total',
        provenance: { sources: [{ kind: 'user', ref: 'msg_bad', trust: 'user' }] },
      },
    });
    expect(resMismatch.statusCode).toBe(400);
    expect(JSON.parse(resMismatch.body).error).toBe('MALFORMED');
  });

  // --------------------------------------------------------------------------
  // 3. Normal Purchase Execution (ALLOW -> CAPTURED)
  // --------------------------------------------------------------------------
  it('POST /v1/intents/propose executes valid in-mandate purchase (ALLOW -> CAPTURED)', async () => {
    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_http_pen_01',
      mandate_id: mandateId,
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_goal_01',
      rationale: 'Office pens purchase',
      provenance: { sources: [{ kind: 'user', ref: 'msg_goal_01', trust: 'user' }] },
    };

    const res = await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: proposal,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('ALLOW');
    expect(body.status).toBe('CAPTURED');
    expect(body.order_id).toBe('ORDER-HTTP-OK');
    expect(body.capture_id).toBe('CAPTURE-HTTP-OK');
    expect(orderCallCount).toBe(1);
    expect(captureCallCount).toBe(1);

    // Verify budget updated: $9.00 captured
    const spendRes = await server.inject({
      method: 'GET',
      url: `/v1/mandates/${mandateId}`,
    });
    expect(spendRes.statusCode).toBe(200);
    const spendBody = JSON.parse(spendRes.body);
    expect(spendBody.spend.captured_minor).toBe(900);
    expect(spendBody.spend.reserved_minor).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 4. Over-Limit Step-Up Purchase & Approval Link
  // --------------------------------------------------------------------------
  it('POST /v1/intents/propose queues STEP_UP purchase and returns approval link', async () => {
    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_http_lamp_01',
      mandate_id: mandateId,
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-DESK-LAMP', qty: 1, claimed_unit_price_minor: 4500 }],
      claimed_total_minor: 4500,
      currency: 'USD',
      user_goal_ref: 'msg_lamp_goal',
      rationale: 'Desk lamp purchase (requires step-up)',
      provenance: { sources: [{ kind: 'user', ref: 'msg_lamp_goal', trust: 'user' }] },
    };

    const res = await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: proposal,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verdict).toBe('STEP_UP');
    expect(body.status).toBe('APPROVED');
    expect(body.links).toBeDefined();
    expect(body.links[0].href).toBe('/v1/intents/int_http_lamp_01/approve');
    expect(body.links[0].rel).toBe('approve');

    // No PayPal calls yet!
    expect(orderCallCount).toBe(0);
    expect(captureCallCount).toBe(0);

    // Budget reserved: exactly $45.00 reserved, $0 captured
    const spend = mandateService.getSpend(mandateId);
    expect(spend.reserved_minor).toBe(4500);
    expect(spend.captured_minor).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 5. Intent Lookup Endpoint (GET /v1/intents/:id)
  // --------------------------------------------------------------------------
  it('GET /v1/intents/:id returns 404 for missing intent and 200 for existing intent', async () => {
    // 404 test
    const notFoundRes = await server.inject({
      method: 'GET',
      url: '/v1/intents/int_nonexistent_99',
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(JSON.parse(notFoundRes.body).error).toBe('INTENT_NOT_FOUND');

    // Create a proposal
    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_http_lookup_01',
      mandate_id: mandateId,
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_lookup',
      rationale: 'Lookup test',
      provenance: { sources: [{ kind: 'user', ref: 'msg_lookup', trust: 'user' }] },
    };

    await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: proposal,
    });

    const getRes = await server.inject({
      method: 'GET',
      url: '/v1/intents/int_http_lookup_01',
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.intent_id).toBe('int_http_lookup_01');
    expect(body.verdict).toBe('ALLOW');
    expect(body.status).toBe('CAPTURED');
    expect(body.decision).toBeDefined();
    expect(body.decision.verdict).toBe('ALLOW');
  });

  // --------------------------------------------------------------------------
  // 6. Human Approval Flow & Payload-Hash Binding Verification (FR-28, AC-9)
  // --------------------------------------------------------------------------
  it('POST /v1/intents/:id/approve verifies payload hash and executes pending STEP_UP', async () => {
    // 1. Propose lamp ($45.00 -> STEP_UP)
    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_http_stepup_flow_01',
      mandate_id: mandateId,
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-DESK-LAMP', qty: 1, claimed_unit_price_minor: 4500 }],
      claimed_total_minor: 4500,
      currency: 'USD',
      user_goal_ref: 'msg_approve_flow',
      rationale: 'Pending human approval',
      provenance: { sources: [{ kind: 'user', ref: 'msg_approve_flow', trust: 'user' }] },
    };

    const proposeRes = await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: proposal,
    });
    expect(proposeRes.statusCode).toBe(200);

    // 2. Tampered approval attempt: supply wrong expected_payload_hash -> 422 PAYLOAD_HASH_MISMATCH
    const tamperedApproveRes = await server.inject({
      method: 'POST',
      url: '/v1/intents/int_http_stepup_flow_01/approve',
      payload: {
        expected_payload_hash: 'bad_tampered_payload_hash_value_1234567890abcdef',
      },
    });
    expect(tamperedApproveRes.statusCode).toBe(422);
    expect(JSON.parse(tamperedApproveRes.body).error).toBe('PAYLOAD_HASH_MISMATCH');
    expect(orderCallCount).toBe(0); // PayPal never called!

    // Reservation was released upon hash mismatch refusal
    const spendAfterReject = mandateService.getSpend(mandateId);
    expect(spendAfterReject.reserved_minor).toBe(0);

    // 3. Fresh STEP_UP proposal for valid approval execution
    const freshProposal: PurchaseIntentProposal = {
      intent_id: 'int_http_stepup_flow_02',
      mandate_id: mandateId,
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-DESK-LAMP', qty: 1, claimed_unit_price_minor: 4500 }],
      claimed_total_minor: 4500,
      currency: 'USD',
      user_goal_ref: 'msg_fresh_approve',
      rationale: 'Fresh step up for approval',
      provenance: { sources: [{ kind: 'user', ref: 'msg_fresh_approve', trust: 'user' }] },
    };

    await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: freshProposal,
    });

    // 4. Valid human approval
    const validApproveRes = await server.inject({
      method: 'POST',
      url: '/v1/intents/int_http_stepup_flow_02/approve',
    });

    expect(validApproveRes.statusCode).toBe(200);
    const validBody = JSON.parse(validApproveRes.body);
    expect(validBody.status).toBe('CAPTURED');
    expect(validBody.order_id).toBe('ORDER-HTTP-OK');
    expect(orderCallCount).toBe(1);
    expect(captureCallCount).toBe(1);

    // Budget shifted from reserved to captured ($45.00 captured, $0 reserved)
    const finalSpend = mandateService.getSpend(mandateId);
    expect(finalSpend.captured_minor).toBe(4500);
    expect(finalSpend.reserved_minor).toBe(0);

    // Verify audit log recorded INTENT_APPROVED with actor = 'user'
    const approvedEvent = db
      .prepare("SELECT actor, type FROM audit_events WHERE type = 'INTENT_APPROVED' AND ref = ?")
      .get('int_http_stepup_flow_02') as { actor: string; type: string } | undefined;
    expect(approvedEvent?.actor).toBe('user');

    // Verify audit log recorded ORDER_CAPTURED with authentic capture ID
    const capturedEvent = db
      .prepare("SELECT actor, type, payload FROM audit_events WHERE type = 'ORDER_CAPTURED' AND ref = ?")
      .get('int_http_stepup_flow_02') as { actor: string; type: string; payload: string } | undefined;
    expect(capturedEvent?.actor).toBe('control_plane');
    expect(capturedEvent?.type).toBe('ORDER_CAPTURED');
    const capturedPayload = JSON.parse(capturedEvent!.payload);
    expect(capturedPayload.capture_id).toBe('CAPTURE-HTTP-OK');
    expect(capturedPayload.order_id).toBe('ORDER-HTTP-OK');

    // 5. Test direct approval passing an existing approved PayPal order ID
    const directOrderProposal: PurchaseIntentProposal = {
      intent_id: 'int_http_stepup_direct_order',
      mandate_id: mandateId,
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-DESK-LAMP', qty: 1, claimed_unit_price_minor: 4500 }],
      claimed_total_minor: 4500,
      currency: 'USD',
      user_goal_ref: 'msg_direct_order',
      rationale: 'Direct approved order capture',
      provenance: { sources: [{ kind: 'user', ref: 'msg_direct_order', trust: 'user' }] },
    };

    await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: directOrderProposal,
    });

    const directApproveRes = await server.inject({
      method: 'POST',
      url: '/v1/intents/int_http_stepup_direct_order/approve',
      payload: {
        paypal_order_id: '0VJ350000M292973P',
      },
    });

    expect(directApproveRes.statusCode).toBe(200);
    const directBody = JSON.parse(directApproveRes.body);
    expect(directBody.order_id).toBe('0VJ350000M292973P');
    expect(directBody.status).toBe('CAPTURED');
    expect(directBody.capture_id).toBe('CAPTURE-HTTP-OK');
  });

  // --------------------------------------------------------------------------
  // 7. Audit Ledger Explorer & Chain Verification (GET /v1/audit/*)
  // --------------------------------------------------------------------------
  it('GET /v1/audit/events returns paginated log and GET /v1/audit/verify confirms integrity', async () => {
    // Generate an intent to populate the ledger
    await server.inject({
      method: 'POST',
      url: '/v1/intents/propose',
      payload: {
        intent_id: 'int_http_audit_pen',
        mandate_id: mandateId,
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_audit',
        rationale: 'Audit generation',
        provenance: { sources: [{ kind: 'user', ref: 'msg_audit', trust: 'user' }] },
      },
    });

    // 1. Audit events list
    const eventsRes = await server.inject({
      method: 'GET',
      url: '/v1/audit/events?limit=10&offset=0',
    });
    expect(eventsRes.statusCode).toBe(200);
    const eventsBody = JSON.parse(eventsRes.body);
    expect(Array.isArray(eventsBody.events)).toBe(true);
    expect(eventsBody.total).toBeGreaterThanOrEqual(5);
    expect(eventsBody.limit).toBe(10);
    expect(eventsBody.offset).toBe(0);

    // Filter by actor
    const actorRes = await server.inject({
      method: 'GET',
      url: '/v1/audit/events?actor=control_plane',
    });
    expect(actorRes.statusCode).toBe(200);
    const actorBody = JSON.parse(actorRes.body);
    expect(actorBody.events.every((e: { actor: string }) => e.actor === 'control_plane')).toBe(true);

    // 2. Audit verification
    const verifyRes = await server.inject({
      method: 'GET',
      url: '/v1/audit/verify',
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = JSON.parse(verifyRes.body);
    expect(verifyBody.valid).toBe(true);
    expect(verifyBody.broken_at_seq).toBeNull();

    // 3. Tamper test: mutate a hash directly in the database
    db.prepare('UPDATE audit_events SET hash = ? WHERE seq = 1').run(
      '000000000000000000000000000000000000000000000000000000000000tampered',
    );

    const tamperedRes = await server.inject({
      method: 'GET',
      url: '/v1/audit/verify',
    });
    expect(tamperedRes.statusCode).toBe(200);
    const tamperedBody = JSON.parse(tamperedRes.body);
    expect(tamperedBody.valid).toBe(false);
    expect(tamperedBody.broken_at_seq).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 8. PayPal Webhook Receiver (POST /v1/webhooks/paypal)
  // --------------------------------------------------------------------------
  it('POST /v1/webhooks/paypal verifies signature and processes asynchronous event', async () => {
    // 1. Success verification case
    webhookVerificationResult = 'SUCCESS';
    const webhookPayload = {
      id: 'WH-EVENT-998877',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAPTURE-WEBHOOK-99',
        custom_id: 'int_some_intent_ref',
        amount: { value: '9.00', currency_code: 'USD' },
      },
    };

    const okRes = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/paypal',
      headers: {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
        'paypal-transmission-id': 'trans_test_123',
        'paypal-transmission-sig': 'sig_mock_456',
        'paypal-transmission-time': '2026-10-20T10:00:00Z',
      },
      payload: webhookPayload,
    });

    expect(okRes.statusCode).toBe(200);
    const okBody = JSON.parse(okRes.body);
    expect(okBody.status).toBe('PROCESSED');
    expect(okBody.event_type).toBe('PAYMENT.CAPTURE.COMPLETED');
    expect(verifyWebhookCount).toBe(1);

    // Audit log captured WEBHOOK_RECEIVED with actor = 'paypal'
    const whAudit = db
      .prepare("SELECT actor, type, ref FROM audit_events WHERE type = 'WEBHOOK_RECEIVED'")
      .get() as { actor: string; type: string; ref: string } | undefined;
    expect(whAudit?.actor).toBe('paypal');
    expect(whAudit?.ref).toBe('WH-EVENT-998877');

    // 2. Failed verification case (forged webhook)
    webhookVerificationResult = 'FAILURE';
    const forgeRes = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/paypal',
      headers: {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://attacker.evil-site.test/cert',
        'paypal-transmission-id': 'trans_forged_999',
        'paypal-transmission-sig': 'sig_forged',
        'paypal-transmission-time': '2026-10-20T10:00:00Z',
      },
      payload: webhookPayload,
    });

    expect(forgeRes.statusCode).toBe(400);
    expect(JSON.parse(forgeRes.body).error).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('AC-6 / INV-10: Spoofed PayPal webhooks are rejected with 400 INVALID_WEBHOOK_SIGNATURE when signature verification fails', async () => {
    webhookVerificationResult = 'FAILURE';
    const spoofedWebhookPayload = {
      id: 'WH-SPOOFED-ATTACK-01',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-SPOOFED-999',
        status: 'COMPLETED',
        amount: { value: '500.00', currency_code: 'USD' },
      },
    };

    const res = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/paypal',
      headers: {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
        'paypal-transmission-id': 'transmission_spoofed_attack',
        'paypal-transmission-sig': 'forged_rsa_signature_bytes==',
        'paypal-transmission-time': '2026-10-20T10:00:00Z',
      },
      payload: spoofedWebhookPayload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('INVALID_WEBHOOK_SIGNATURE');
    expect(body.message).toBe('PayPal webhook signature verification failed');

    // Verify audit ledger has zero rogue captured events from the spoofed webhook
    const rogueEvents = db
      .prepare("SELECT * FROM audit_events WHERE ref = 'WH-SPOOFED-ATTACK-01'")
      .all();
    expect(rogueEvents).toHaveLength(0);
  });
});
