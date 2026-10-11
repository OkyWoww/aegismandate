import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DatabaseConnection } from '@mandatepay/audit';
import { MandateService, initMandateTables } from './mandate-service.js';
import {
  executeGoldenPath,
  initExecutorTables,
  computeApprovalPayloadHash,
  generatePayPalRequestId,
  pollOrderStatus,
  type StoreCatalogResolver,
} from './executor.js';
import { PayPalClient } from '@mandatepay/paypal';
import type { PurchaseIntentProposal } from '@mandatepay/schemas';

const TEST_HMAC_KEY = 'test_mandate_hmac_secret_key_hardening_32chars!';

function setupDatabase(db: DatabaseConnection) {
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

  db.prepare(`
    INSERT OR REPLACE INTO merchants (id, name, paypal_payee_ref, base_url)
    VALUES (?, ?, ?, ?)
  `).run('mrc_demo_store', 'Demo Supplies Co.', 'merchant@demo-store.local', 'https://demo-store.local');

  db.prepare(`
    INSERT OR REPLACE INTO catalog_items (sku, merchant_id, name, category, price_minor)
    VALUES (?, ?, ?, ?, ?)
  `).run('SKU-PEN-PACK', 'mrc_demo_store', 'Ballpoint Pen 10-pack', 'office_supplies', 900);
}

function createCatalogResolver(db: DatabaseConnection): StoreCatalogResolver {
  return {
    getMerchantPayee: (ref: string) => {
      const row = db
        .prepare('SELECT id, name, paypal_payee_ref FROM merchants WHERE id = ?')
        .get(ref) as { id: string; name: string; paypal_payee_ref: string } | undefined;
      return row
        ? {
            merchantId: row.id,
            name: row.name,
            payeeRef: row.paypal_payee_ref,
          }
        : null;
    },
    getItem: (merchantRef: string, sku: string) => {
      const row = db
        .prepare('SELECT price_minor, name, category FROM catalog_items WHERE merchant_id = ? AND sku = ?')
        .get(merchantRef, sku) as { price_minor: number; name: string; category: string } | undefined;
      return row
        ? {
            verified: true,
            priceMinor: row.price_minor,
            name: row.name,
            category: row.category,
          }
        : null;
    },
  };
}

describe('Executor Hardening (Task T-008, AC-3, AC-9, AC-10, FR-14, FR-28, FR-29)', () => {
  let db: DatabaseConnection;
  let mandateService: MandateService;
  let catalogResolver: StoreCatalogResolver;

  beforeEach(() => {
    db = openDb(':memory:');
    setupDatabase(db);
    catalogResolver = createCatalogResolver(db);

    const fixedTime = '2026-10-20T08:00:00Z';
    mandateService = new MandateService(db, TEST_HMAC_KEY, () => fixedTime);

    mandateService.createDraft({
      mandate_id: 'mnd_hardened_01',
      owner_id: 'usr_demo',
      agent_id: 'agt_shopper_1',
      currency: 'USD',
      valid_from: '2026-10-20T00:00:00Z',
      valid_until: '2026-10-20T20:00:00Z',
      total_budget_minor: 20000,
      per_txn_limit_minor: 8000,
      auto_approve_limit_minor: 3000,
      max_txns_per_hour: 3,
      allowed_merchants: ['mrc_demo_store'],
      allowed_categories: ['office_supplies'],
      max_items_per_intent: 5,
      max_pending_approvals: 3,
      suspend_after_denies: 5,
      step_up: { channel: 'dashboard', timeout_seconds: 300 },
      risk: { step_up_threshold: 40, deny_threshold: 75 },
      wallet: { type: 'paypal_vault', ref: 'pt_sandbox_shopper' },
      created_at: '2026-10-20T00:00:00Z',
    });
    mandateService.activate('mnd_hardened_01');
  });

  it('AC-3: Idempotency — repeated submission returns stored decision and creates exactly one PayPal order', async () => {
    let createOrderCallCount = 0;
    const recordedRequestIds: string[] = [];

    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_ac3',
      clientSecret: 'sandbox_client_sec_ac3',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_ac3', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('/capture') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ id: 'CAP-AC3-01', status: 'COMPLETED', amount: { currency_code: 'USD', value: '9.00' } }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          createOrderCallCount++;
          const headers = init.headers as Record<string, string>;
          if (headers['PayPal-Request-Id']) {
            recordedRequestIds.push(headers['PayPal-Request-Id']);
          }
          return new Response(
            JSON.stringify({
              id: 'ORDER-AC3-01',
              status: 'CREATED',
              intent: 'CAPTURE',
              purchase_units: [{ amount: { value: '9.00', currency_code: 'USD' } }],
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_idempotent_test_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_pen_purchase',
      rationale: 'Purchase pen for office notes',
      provenance: { sources: [{ kind: 'user', ref: 'msg_pen_purchase', trust: 'user' }] },
    };

    // First execution
    const res1 = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: '2026-10-20T08:05:00Z',
    });

    expect(res1.status).toBe('CAPTURED');
    expect(res1.orderId).toBe('ORDER-AC3-01');
    expect(createOrderCallCount).toBe(1);
    expect(recordedRequestIds).toHaveLength(1);
    expect(recordedRequestIds[0]).toBe(generatePayPalRequestId('int_idempotent_test_01', 'create_order'));

    // Second execution (replay with identical intent_id)
    const res2 = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: '2026-10-20T08:06:00Z',
    });

    // Must return the stored result without calling PayPal again
    expect(res2.status).toBe('CAPTURED');
    expect(res2.orderId).toBe('ORDER-AC3-01');
    expect(res2.decision.decision_id).toBe(res1.decision.decision_id);
    expect(createOrderCallCount).toBe(1); // Zero additional PayPal calls!
  });

  it('AC-9: Approval Binding — mutating payload after approval triggers PAYLOAD_HASH_MISMATCH and creates no order', async () => {
    let orderCallCount = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_ac9',
      clientSecret: 'sandbox_client_sec_ac9',
      environment: 'sandbox',
      fetchFn: async () => {
        orderCallCount++;
        return new Response('{}', { status: 200 });
      },
    });

    const originalProposal: PurchaseIntentProposal = {
      intent_id: 'int_binding_test_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_original',
      rationale: 'Original approved purchase',
      provenance: { sources: [{ kind: 'user', ref: 'msg_original', trust: 'user' }] },
    };

    // Compute expected approval hash on the authentic approved facts
    const approvedPayloadHash = computeApprovalPayloadHash({
      mandate_id: 'mnd_hardened_01',
      mandate_version: 1,
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, unit_price_minor: 900 }],
      verified_total_minor: 900,
      payee_ref: 'merchant@demo-store.local',
    });

    // Tampered proposal: attacker mutates qty to 2 (or changes price/merchant)
    const tamperedProposal: PurchaseIntentProposal = {
      ...originalProposal,
      items: [{ sku: 'SKU-PEN-PACK', qty: 2, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 1800,
    };

    const res = await executeGoldenPath({
      proposal: tamperedProposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      expectedPayloadHash: approvedPayloadHash,
      now: '2026-10-20T08:10:00Z',
    });

    expect(res.verdict).toBe('DENY');
    expect(res.status).toBe('FAILED');
    expect(res.refusalReason).toBe('PAYLOAD_HASH_MISMATCH');
    expect(orderCallCount).toBe(0); // Strictly zero PayPal orders created!

    // Verify audit contains INTENT_REFUSED
    const auditRow = db
      .prepare("SELECT type, payload FROM audit_events WHERE type = 'INTENT_REFUSED'")
      .get() as { type: string; payload: string } | undefined;
    expect(auditRow).toBeDefined();
    expect(JSON.parse(auditRow!.payload).reason).toBe('PAYLOAD_HASH_MISMATCH');
  });

  it('AC-10: Execution-time Recheck — revoking mandate mid-flight aborts execution with zero orders created', async () => {
    let orderCallCount = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_ac10_rev',
      clientSecret: 'sandbox_client_sec_ac10_rev',
      environment: 'sandbox',
      fetchFn: async () => {
        orderCallCount++;
        return new Response('{}', { status: 200 });
      },
    });

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_recheck_revoked_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_revoked_test',
      rationale: 'Testing execution recheck revocation',
      provenance: { sources: [{ kind: 'user', ref: 'msg_revoked_test', trust: 'user' }] },
    };

    const res = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      onBeforeExecution: () => {
        // User revokes the mandate mid-flight, after decision & reservation but immediately before PayPal execution
        mandateService.revoke('mnd_hardened_01', 'User emergency revoke', 'user');
      },
      now: '2026-10-20T08:15:00Z',
    });

    expect(res.verdict).toBe('DENY');
    expect(res.status).toBe('FAILED');
    expect(orderCallCount).toBe(0); // Zero PayPal calls
    expect(mandateService.getSpend('mnd_hardened_01').reserved_minor).toBe(0); // No orphan reservation
  });

  it('AC-10: Execution-time Recheck — expiring mandate mid-flight aborts execution with MANDATE_EXPIRED', async () => {
    let orderCallCount = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_ac10_exp',
      clientSecret: 'sandbox_client_sec_ac10_exp',
      environment: 'sandbox',
      fetchFn: async () => {
        orderCallCount++;
        return new Response('{}', { status: 200 });
      },
    });

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_recheck_expired_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_expired_test',
      rationale: 'Testing execution recheck expiry',
      provenance: { sources: [{ kind: 'user', ref: 'msg_expired_test', trust: 'user' }] },
    };

    let simulatedClock = '2026-10-20T08:15:00Z'; // valid
    const res = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      onBeforeExecution: () => {
        // Clock fast-forwards past valid_until (2026-10-20T20:00:00Z)
        simulatedClock = '2026-10-20T21:00:00Z';
      },
      get now() {
        return simulatedClock;
      },
    });

    expect(res.verdict).toBe('DENY');
    expect(res.status).toBe('FAILED');
    expect(res.refusalReason).toBe('MANDATE_EXPIRED');
    expect(orderCallCount).toBe(0);
    expect(mandateService.getSpend('mnd_hardened_01').reserved_minor).toBe(0);
  });

  it('AC-10: Execution-time Recheck — store price change mid-flight aborts execution with PRICE_CHANGED_AT_EXEC', async () => {
    let orderCallCount = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_ac10_price',
      clientSecret: 'sandbox_client_sec_ac10_price',
      environment: 'sandbox',
      fetchFn: async () => {
        orderCallCount++;
        return new Response('{}', { status: 200 });
      },
    });

    // Mock catalog resolver where price changes on second lookup (simulating TOCTOU price jump)
    let queryCount = 0;
    const dynamicResolver: StoreCatalogResolver = {
      ...catalogResolver,
      getItem: (_merchantRef, _sku) => {
        queryCount++;
        if (queryCount === 1) {
          // Intake lookup: $9.00
          return { verified: true, priceMinor: 900, name: 'Ballpoint Pen', category: 'office_supplies' };
        }
        // Execution recheck lookup: Merchant raised price to $12.00 mid-flight!
        return { verified: true, priceMinor: 1200, name: 'Ballpoint Pen', category: 'office_supplies' };
      },
    };

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_price_tamper_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_price_change',
      rationale: 'Testing price fluctuation handling',
      provenance: { sources: [{ kind: 'user', ref: 'msg_price_change', trust: 'user' }] },
    };

    const res = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver: dynamicResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: '2026-10-20T08:20:00Z',
    });

    expect(res.verdict).toBe('DENY');
    expect(res.status).toBe('FAILED');
    expect(res.refusalReason).toBe('PRICE_CHANGED_AT_EXEC');
    expect(orderCallCount).toBe(0); // Zero PayPal calls
    expect(mandateService.getSpend('mnd_hardened_01').reserved_minor).toBe(0); // Reservation freed cleanly
  });

  it('Network Resilience: Retries on PayPal 5xx with identical idempotency key and recovers', async () => {
    let attemptCount = 0;
    const requestIdsSent: string[] = [];

    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_5xx',
      clientSecret: 'sandbox_client_sec_5xx',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_5xx', expires_in: 3600 }), { status: 200 });
        }
        if (urlStr.includes('/capture') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'CAP-5XX', status: 'COMPLETED' }), { status: 201 });
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          attemptCount++;
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const reqId = headers['PayPal-Request-Id'];
          if (reqId) {
            requestIdsSent.push(reqId);
          }

          if (attemptCount === 1) {
            // First attempt: PayPal returns 503 Service Unavailable
            return new Response('{"error": "Service Unavailable"}', { status: 503, statusText: 'Service Unavailable' });
          }
          // Second attempt: succeeds
          return new Response(
            JSON.stringify({
              id: 'ORDER-5XX-RECOVERED',
              status: 'CREATED',
              intent: 'CAPTURE',
              purchase_units: [{ amount: { value: '9.00', currency_code: 'USD' } }],
            }),
            { status: 201 },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_5xx_retry_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_retry_test',
      rationale: 'Testing network 5xx retry',
      provenance: { sources: [{ kind: 'user', ref: 'msg_retry_test', trust: 'user' }] },
    };

    const res = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      retryConfig: { maxRetries: 3, initialDelayMs: 5, backoffFactor: 1 },
      now: '2026-10-20T08:25:00Z',
    });

    expect(attemptCount).toBe(2);
    expect(res.status).toBe('CAPTURED');
    expect(res.orderId).toBe('ORDER-5XX-RECOVERED');
    // Critical: Identical idempotency key reused across retries
    expect(requestIdsSent).toHaveLength(2);
    expect(requestIdsSent[0]).toBe(requestIdsSent[1]);
  });

  it('Network Resilience: Persistent 5xx cleans up budget reservation without orphan state', async () => {
    let attemptCount = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_persist_5xx',
      clientSecret: 'sandbox_client_sec_persist_5xx',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_5xx', expires_in: 3600 }), { status: 200 });
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          attemptCount++;
          return new Response('{"error": "Internal Error"}', { status: 500, statusText: 'Internal Error' });
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_persist_5xx_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_persist_5xx',
      rationale: 'Testing persistent 5xx failure cleanup',
      provenance: { sources: [{ kind: 'user', ref: 'msg_persist_5xx', trust: 'user' }] },
    };

    const res = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      retryConfig: { maxRetries: 2, initialDelayMs: 2, backoffFactor: 1 },
      now: '2026-10-20T08:30:00Z',
    });

    expect(attemptCount).toBe(2);
    expect(res.status).toBe('FAILED');
    expect(res.refusalReason).toBe('PAYPAL_CREATE_FAILED');

    // Reservation must be cleanly freed: zero reserved, zero captured
    const spend = mandateService.getSpend('mnd_hardened_01');
    expect(spend.reserved_minor).toBe(0);
    expect(spend.captured_minor).toBe(0);

    // Audit event ORDER_FAILED must be logged
    const failedEvent = db
      .prepare("SELECT type FROM audit_events WHERE type = 'ORDER_FAILED'")
      .get() as { type: string } | undefined;
    expect(failedEvent).toBeDefined();
  });

  it('Polling Fallback: pollOrderStatus reconciles delayed webhook to COMPLETED status and settles spend', async () => {
    // Setup a pre-existing reservation for an intent
    mandateService.reserve({
      mandateId: 'mnd_hardened_01',
      intentId: 'int_polling_01',
      amountMinor: 900,
    });

    // Record initial executed_intent as APPROVED (pending capture)
    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'int_polling_01',
      'mnd_hardened_01',
      'ALLOW',
      '{}',
      'APPROVED',
      'ORDER-POLL-01',
      null,
      'hash_poll',
      null,
      '2026-10-20T08:35:00Z',
      '2026-10-20T08:35:00Z',
    );

    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_poll',
      clientSecret: 'sandbox_client_sec_poll',
      environment: 'sandbox',
      fetchFn: async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_poll', expires_in: 3600 }), { status: 200 });
        }
        if (urlStr.includes('/v2/checkout/orders/ORDER-POLL-01')) {
          return new Response(
            JSON.stringify({
              id: 'ORDER-POLL-01',
              status: 'COMPLETED',
              intent: 'CAPTURE',
            }),
            { status: 200 },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const pollRes = await pollOrderStatus({
      intentId: 'int_polling_01',
      orderId: 'ORDER-POLL-01',
      payPalClient,
      mandateService,
      db,
      now: '2026-10-20T08:36:00Z',
    });

    expect(pollRes.reconciled).toBe(true);
    expect(pollRes.settled).toBe(true);
    expect(pollRes.status).toBe('COMPLETED');

    // Spend is shifted to captured
    const spend = mandateService.getSpend('mnd_hardened_01');
    expect(spend.captured_minor).toBe(900);
    expect(spend.reserved_minor).toBe(0);

    // Audit event POLLING_RECONCILED logged
    const pollEvent = db
      .prepare("SELECT type, payload FROM audit_events WHERE type = 'POLLING_RECONCILED'")
      .get() as { type: string; payload: string } | undefined;
    expect(pollEvent).toBeDefined();
    expect(JSON.parse(pollEvent!.payload).reconciled_to).toBe('CAPTURED');
  });
});
