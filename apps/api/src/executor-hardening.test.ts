import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DatabaseConnection } from '@mandatepay/audit';
import { MandateService, initMandateTables } from './mandate-service.js';
import {
  executeGoldenPath,
  initExecutorTables,
  computeApprovalPayloadHash,
  generatePayPalRequestId,
  pollOrderStatus,
  sweepExpiredIntents,
  captureApprovedOrder,
  reconcileCapturingIntents,
  executeApprovedStepUp,
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

    expect(res1.status).toBe('AWAITING_PAYER_APPROVAL');
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
    expect(res2.status).toBe('AWAITING_PAYER_APPROVAL');
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
    expect(res.status).toBe('AWAITING_PAYER_APPROVAL');
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
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'int_polling_01',
      'mnd_hardened_01',
      'mrc_demo_store',
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
              purchase_units: [
                {
                  reference_id: 'int_polling_01',
                  amount: { value: '9.00', currency_code: 'USD' },
                  payee: { email_address: 'merchant@demo-store.local' },
                  payments: {
                    captures: [{ id: 'CAP-POLL-01', status: 'COMPLETED' }],
                  },
                },
              ],
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
      catalogResolver,
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

  // --------------------------------------------------------------------------
  // Round 5 Hardening: Race Condition Sweeper vs Capture (Guardrail 4, FR-34)
  // --------------------------------------------------------------------------
  it('Race condition: Sweeper vs Capture race produces exactly one winner and preserves budget invariants (Guardrail 4, FR-34)', async () => {
    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_race_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_race',
      rationale: 'Race test intent',
      provenance: { sources: [{ kind: 'user', ref: 'msg_race', trust: 'user' }] },
    };

    let captureCallCount = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_race',
      clientSecret: 'sandbox_client_sec_race',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_race', expires_in: 3600 }), { status: 200 });
        }
        if (urlStr.includes('/capture') && init?.method === 'POST') {
          captureCallCount++;
          return new Response(
            JSON.stringify({
              id: 'CAP-RACE-01',
              status: 'COMPLETED',
              amount: { currency_code: 'USD', value: '9.00' },
              purchase_units: [{ payments: { captures: [{ id: 'CAP-RACE-01', status: 'COMPLETED' }] } }],
            }),
            { status: 201 },
          );
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              id: 'ORDER-RACE-01',
              status: 'CREATED',
              intent: 'CAPTURE',
              purchase_units: [{ amount: { value: '9.00', currency_code: 'USD' } }],
              links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-RACE-01' }],
            }),
            { status: 201 },
          );
        }
        if (urlStr.includes('/v2/checkout/orders/ORDER-RACE-01')) {
          return new Response(
            JSON.stringify({
              id: 'ORDER-RACE-01',
              status: 'APPROVED',
              intent: 'CAPTURE',
              purchase_units: [
                {
                  reference_id: 'int_race_01',
                  amount: { value: '9.00', currency_code: 'USD' },
                  payee: { email_address: 'merchant@demo-store.local' },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const t0 = '2026-10-20T08:00:00Z';
    const proposeRes = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: t0,
    });
    expect(proposeRes.status).toBe('AWAITING_PAYER_APPROVAL');
    expect(mandateService.getSpend('mnd_hardened_01').reserved_minor).toBe(900);

    const t1Expired = '2026-10-20T08:16:00Z';

    const [sweepResult, captureResult] = await Promise.all([
      Promise.resolve().then(() => sweepExpiredIntents(db, mandateService, t1Expired)),
      captureApprovedOrder({
        intentId: 'int_race_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: t1Expired,
      }),
    ]);

    expect(sweepResult).toBeDefined();
    const finalSpend = mandateService.getSpend('mnd_hardened_01');
    const finalRow = db.prepare('SELECT status FROM executed_intents WHERE intent_id = ?').get('int_race_01') as { status: string };

    if (finalRow.status === 'EXPIRED') {
      expect(captureResult.status).toBe('EXPIRED');
      expect(captureCallCount).toBe(0);
      expect(finalSpend.reserved_minor).toBe(0);
      expect(finalSpend.captured_minor).toBe(0);
    } else {
      expect(captureResult.status).toBe('CAPTURED');
      expect(finalRow.status).toBe('CAPTURED');
      expect(captureCallCount).toBe(1);
      expect(finalSpend.reserved_minor).toBe(0);
      expect(finalSpend.captured_minor).toBe(900);
    }

    expect(finalSpend.captured_minor + finalSpend.reserved_minor).toBeLessThanOrEqual(20000);
  });

  // --------------------------------------------------------------------------
  // Round 5 Hardening: AC-12 Approval Expiry & Refusal of Expired Capture
  // --------------------------------------------------------------------------
  it('AC-12: Approval expiry — unapproved order past timeout transitions to EXPIRED, releases reservation, and refuses capture with zero captureOrder calls', async () => {
    let captureOrderCalls = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_ac12',
      clientSecret: 'sandbox_client_sec_ac12',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_ac12', expires_in: 3600 }), { status: 200 });
        }
        if (urlStr.includes('/capture')) {
          captureOrderCalls++;
          return new Response(JSON.stringify({ id: 'CAP-AC12', status: 'COMPLETED' }), { status: 201 });
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              id: 'ORDER-AC12-01',
              status: 'CREATED',
              links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-AC12-01' }],
            }),
            { status: 201 },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_ac12_timeout_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_ac12',
      rationale: 'Timeout test',
      provenance: { sources: [{ kind: 'user', ref: 'msg_ac12', trust: 'user' }] },
    };

    const t0 = '2026-10-20T08:00:00Z';
    const res0 = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: t0,
    });
    expect(res0.status).toBe('AWAITING_PAYER_APPROVAL');
    expect(mandateService.getSpend('mnd_hardened_01').reserved_minor).toBe(900);

    const tExpired = '2026-10-20T08:16:00Z';

    const capRes = await captureApprovedOrder({
      intentId: 'int_ac12_timeout_01',
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      now: tExpired,
    });

    expect(capRes.status).toBe('EXPIRED');
    expect(capRes.refusalReason).toBe('PAYER_APPROVAL_TIMEOUT');
    expect(captureOrderCalls).toBe(0);

    const spendAfter = mandateService.getSpend('mnd_hardened_01');
    expect(spendAfter.reserved_minor).toBe(0);
    expect(spendAfter.captured_minor).toBe(0);

    const expiredAudit = db
      .prepare("SELECT type, payload FROM audit_events WHERE type = 'INTENT_EXPIRED' AND ref = ?")
      .get('int_ac12_timeout_01') as { type: string; payload: string } | undefined;
    expect(expiredAudit).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Round 5 Hardening: AC-14 Idempotent Capture & ORDER_ALREADY_CAPTURED Error Recovery
  // --------------------------------------------------------------------------
  it('AC-14: Idempotent Capture — deterministic PayPal-Request-Id, ORDER_ALREADY_CAPTURED error recovery, and crash-after-capture recovery', async () => {
    let captureCallCount = 0;
    const requestIdsCaptured: string[] = [];
    const throwAlreadyCaptured = true;
    let orderStatus = 'APPROVED';

    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_ac14',
      clientSecret: 'sandbox_client_sec_ac14',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_ac14', expires_in: 3600 }), { status: 200 });
        }
        if (urlStr.includes('/capture') && init?.method === 'POST') {
          captureCallCount++;
          const headers = (init.headers ?? {}) as Record<string, string>;
          if (headers['PayPal-Request-Id']) {
            requestIdsCaptured.push(headers['PayPal-Request-Id']);
          }
          orderStatus = 'COMPLETED';
          if (throwAlreadyCaptured) {
            return new Response(
              JSON.stringify({
                name: 'UNPROCESSABLE_ENTITY',
                message: 'The order has already been captured.',
                details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Order already captured' }],
              }),
              { status: 422 },
            );
          }
          return new Response(
            JSON.stringify({
              id: 'CAP-AC14-ORIGINAL',
              status: 'COMPLETED',
              amount: { currency_code: 'USD', value: '9.00' },
              purchase_units: [{ payments: { captures: [{ id: 'CAP-AC14-ORIGINAL', status: 'COMPLETED' }] } }],
            }),
            { status: 201 },
          );
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              id: 'ORDER-AC14-01',
              status: 'CREATED',
              links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-AC14-01' }],
            }),
            { status: 201 },
          );
        }
        if (urlStr.includes('/v2/checkout/orders/ORDER-AC14-01')) {
          return new Response(
            JSON.stringify({
              id: 'ORDER-AC14-01',
              status: orderStatus,
              intent: 'CAPTURE',
              purchase_units: [
                {
                  reference_id: 'int_ac14_01',
                  amount: { value: '9.00', currency_code: 'USD' },
                  payee: { email_address: 'merchant@demo-store.local' },
                  payments: {
                    captures: [{ id: 'CAP-AC14-RECONCILED', status: 'COMPLETED' }],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes('/v2/checkout/orders/ORDER-CRASH-01')) {
          return new Response(
            JSON.stringify({
              id: 'ORDER-CRASH-01',
              status: 'COMPLETED',
              intent: 'CAPTURE',
              purchase_units: [
                {
                  reference_id: 'int_crash_recovery_01',
                  amount: { value: '9.00', currency_code: 'USD' },
                  payee: { email_address: 'merchant@demo-store.local' },
                  payments: {
                    captures: [{ id: 'CAP-CRASH-RECONCILED', status: 'COMPLETED' }],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_ac14_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_ac14',
      rationale: 'Idempotent capture test',
      provenance: { sources: [{ kind: 'user', ref: 'msg_ac14', trust: 'user' }] },
    };

    const t0 = '2026-10-20T08:00:00Z';
    await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: t0,
    });

    const capRes1 = await captureApprovedOrder({
      intentId: 'int_ac14_01',
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      now: '2026-10-20T08:05:00Z',
    });

    expect(capRes1.status).toBe('CAPTURED');
    expect(capRes1.captureId).toBe('CAP-AC14-RECONCILED');
    expect(requestIdsCaptured).toHaveLength(1);
    expect(requestIdsCaptured[0]).toBe(generatePayPalRequestId('int_ac14_01', 'capture_order'));

    const initialCallCount = captureCallCount;
    const capRes2 = await captureApprovedOrder({
      intentId: 'int_ac14_01',
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      now: '2026-10-20T08:06:00Z',
    });

    expect(capRes2.status).toBe('CAPTURED');
    expect(capRes2.captureId).toBe('CAP-AC14-RECONCILED');
    expect(captureCallCount).toBe(initialCallCount);

    mandateService.reserve({
      mandateId: 'mnd_hardened_01',
      intentId: 'int_crash_recovery_01',
      amountMinor: 900,
    });
    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status, order_id, capture_id, payload_hash, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'int_crash_recovery_01',
      'mnd_hardened_01',
      'mrc_demo_store',
      'ALLOW',
      '{}',
      'CAPTURING',
      'ORDER-CRASH-01',
      null,
      'hash_crash',
      null,
      t0,
      t0,
    );

    const reconciled = await reconcileCapturingIntents({
      db,
      payPalClient,
      mandateService,
      catalogResolver,
      now: '2026-10-20T08:10:00Z',
    });

    expect(reconciled).toContain('int_crash_recovery_01');
    const recoveredRow = db.prepare('SELECT status, capture_id FROM executed_intents WHERE intent_id = ?').get('int_crash_recovery_01') as { status: string; capture_id: string };
    expect(recoveredRow.status).toBe('CAPTURED');
    expect(recoveredRow.capture_id).toBe('CAP-CRASH-RECONCILED');
  });

  // --------------------------------------------------------------------------
  // Round 5 Hardening: FR-38 Step-Up Lifecycle & Queue Discipline
  // --------------------------------------------------------------------------
  it('FR-38: Step-Up lifecycle — withhold order until confirm, reject frees budget, timeout frees budget, payload_hash mismatch refuses, and queue full enforces cap', async () => {
    let orderCalls = 0;
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_stepup',
      clientSecret: 'sandbox_client_sec_stepup',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'tok_stepup', expires_in: 3600 }), { status: 200 });
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          orderCalls++;
          return new Response(
            JSON.stringify({
              id: 'ORDER-STEPUP-OK',
              status: 'CREATED',
              links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-STEPUP-OK' }],
            }),
            { status: 201 },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const lampProposal: PurchaseIntentProposal = {
      intent_id: 'int_stepup_spec_01',
      mandate_id: 'mnd_hardened_01',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 5, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 4500,
      currency: 'USD',
      user_goal_ref: 'msg_lamp',
      rationale: 'Step up bulk pens',
      provenance: { sources: [{ kind: 'user', ref: 'msg_lamp', trust: 'user' }] },
    };

    const t0 = '2026-10-20T08:00:00Z';
    const stepUpRes = await executeGoldenPath({
      proposal: lampProposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: t0,
    });

    expect(stepUpRes.verdict).toBe('STEP_UP');
    expect(stepUpRes.status).toBe('APPROVED');
    expect(stepUpRes.orderId).toBeUndefined();
    expect(stepUpRes.approveUrl).toBeUndefined();
    expect(orderCalls).toBe(0);

    const spendPending = mandateService.getSpend('mnd_hardened_01');
    expect(spendPending.reserved_minor).toBe(4500);

    const releaseRes = mandateService.releaseReservation('int_stepup_spec_01', 'Owner rejected');
    expect(releaseRes.success).toBe(true);
    expect(mandateService.getSpend('mnd_hardened_01').reserved_minor).toBe(0);

    const lampProposal2: PurchaseIntentProposal = {
      ...lampProposal,
      intent_id: 'int_stepup_spec_02',
    };
    await executeGoldenPath({
      proposal: lampProposal2,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: t0,
    });
    expect(orderCalls).toBe(0);

    const confirmRes = await executeApprovedStepUp({
      intentId: 'int_stepup_spec_02',
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: t0,
    });

    expect(confirmRes.status).toBe('AWAITING_PAYER_APPROVAL');
    expect(confirmRes.orderId).toBe('ORDER-STEPUP-OK');
    expect(confirmRes.approveUrl).toBeDefined();
    expect(orderCalls).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Round 5 Hardening: Negative Preflight Tests (FR-35, INV-6, INV-7)
  // --------------------------------------------------------------------------
  describe('Fail-Closed Preflight Negative Tests (FR-35, INV-6, INV-7)', () => {
    it('Preflight fails closed when order response is missing reference_id (zero captureOrder calls)', async () => {
      let captureOrderCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_neg',
        clientSecret: 'sandbox_client_sec_neg',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_neg', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/capture')) {
            captureOrderCalls++;
            return new Response(JSON.stringify({ id: 'CAP-ERR', status: 'COMPLETED' }), { status: 201 });
          }
          if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-NEG-NO-REF',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-NEG-NO-REF' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-NEG-NO-REF')) {
            return new Response(
              JSON.stringify({
                id: 'ORDER-NEG-NO-REF',
                status: 'APPROVED',
                intent: 'CAPTURE',
                purchase_units: [
                  {
                    // reference_id is MISSING
                    amount: { value: '9.00', currency_code: 'USD' },
                    payee: { email_address: 'merchant@demo-store.local' },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_neg_no_ref_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_neg_ref',
        rationale: 'Negative test missing reference_id',
        provenance: { sources: [{ kind: 'user', ref: 'msg_neg_ref', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const capRes = await captureApprovedOrder({
        intentId: 'int_neg_no_ref_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:05:00Z',
      });

      expect(capRes.status).toBe('FAILED');
      expect(capRes.refusalReason).toBe('PREFLIGHT_VALIDATION_FAILED');
      expect(captureOrderCalls).toBe(0);

      // Verify reservation released atomically
      const spend = mandateService.getSpend('mnd_hardened_01');
      expect(spend.reserved_minor).toBe(0);
      expect(spend.captured_minor).toBe(0);

      // Verify audit event
      const audit = db.prepare("SELECT type FROM audit_events WHERE type = 'ORDER_PREFLIGHT_FAILED' AND ref = ?").get('int_neg_no_ref_01');
      expect(audit).toBeDefined();
    });

    it('Preflight fails closed when order response is missing amount or amount.value (zero captureOrder calls)', async () => {
      let captureOrderCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_neg',
        clientSecret: 'sandbox_client_sec_neg',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_neg', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/capture')) {
            captureOrderCalls++;
            return new Response(JSON.stringify({ id: 'CAP-ERR', status: 'COMPLETED' }), { status: 201 });
          }
          if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-NEG-NO-AMT',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-NEG-NO-AMT' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-NEG-NO-AMT')) {
            return new Response(
              JSON.stringify({
                id: 'ORDER-NEG-NO-AMT',
                status: 'APPROVED',
                intent: 'CAPTURE',
                purchase_units: [
                  {
                    reference_id: 'int_neg_no_amt_01',
                    // amount is MISSING
                    payee: { email_address: 'merchant@demo-store.local' },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_neg_no_amt_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_neg_amt',
        rationale: 'Negative test missing amount',
        provenance: { sources: [{ kind: 'user', ref: 'msg_neg_amt', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const capRes = await captureApprovedOrder({
        intentId: 'int_neg_no_amt_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:05:00Z',
      });

      expect(capRes.status).toBe('FAILED');
      expect(capRes.refusalReason).toBe('PREFLIGHT_VALIDATION_FAILED');
      expect(captureOrderCalls).toBe(0);

      const spend = mandateService.getSpend('mnd_hardened_01');
      expect(spend.reserved_minor).toBe(0);
      expect(spend.captured_minor).toBe(0);
    });

    it('Preflight fails closed when order response is missing payee (zero captureOrder calls)', async () => {
      let captureOrderCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_neg',
        clientSecret: 'sandbox_client_sec_neg',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_neg', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/capture')) {
            captureOrderCalls++;
            return new Response(JSON.stringify({ id: 'CAP-ERR', status: 'COMPLETED' }), { status: 201 });
          }
          if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-NEG-NO-PAYEE',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-NEG-NO-PAYEE' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-NEG-NO-PAYEE')) {
            return new Response(
              JSON.stringify({
                id: 'ORDER-NEG-NO-PAYEE',
                status: 'APPROVED',
                intent: 'CAPTURE',
                purchase_units: [
                  {
                    reference_id: 'int_neg_no_payee_01',
                    amount: { value: '9.00', currency_code: 'USD' },
                    // payee is MISSING
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_neg_no_payee_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_neg_payee',
        rationale: 'Negative test missing payee',
        provenance: { sources: [{ kind: 'user', ref: 'msg_neg_payee', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const capRes = await captureApprovedOrder({
        intentId: 'int_neg_no_payee_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:05:00Z',
      });

      expect(capRes.status).toBe('FAILED');
      expect(capRes.refusalReason).toBe('PREFLIGHT_VALIDATION_FAILED');
      expect(captureOrderCalls).toBe(0);

      const spend = mandateService.getSpend('mnd_hardened_01');
      expect(spend.reserved_minor).toBe(0);
      expect(spend.captured_minor).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Round 5 Hardening: Negative Reconciliation & Recovery Tests (FR-37, rule.md §3.6)
  // --------------------------------------------------------------------------
  describe('Harden ORDER_ALREADY_CAPTURED & Reconciliation (FR-37, rule.md §3.6)', () => {
    it('ORDER_ALREADY_CAPTURED with empty captures: [] transitions to FAILED, audits error, and does NOT record ORDER_CAPTURED', async () => {
      let getOrderCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_ac14_empty',
        clientSecret: 'sandbox_client_sec_ac14_empty',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_ac14_empty', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/capture') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                name: 'UNPROCESSABLE_ENTITY',
                message: 'The order has already been captured.',
                details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Order already captured' }],
              }),
              { status: 422 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-EMPTY-CAP-01',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-EMPTY-CAP-01' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-EMPTY-CAP-01')) {
            getOrderCalls++;
            if (getOrderCalls === 1) {
              // Initial preflight getOrder returns APPROVED so captureOrder is dispatched
              return new Response(
                JSON.stringify({
                  id: 'ORDER-EMPTY-CAP-01',
                  status: 'APPROVED',
                  intent: 'CAPTURE',
                  purchase_units: [
                    {
                      reference_id: 'int_empty_caps_01',
                      amount: { value: '9.00', currency_code: 'USD' },
                      payee: { email_address: 'merchant@demo-store.local' },
                    },
                  ],
                }),
                { status: 200 },
              );
            }
            // Reconciled order response has EMPTY captures array
            return new Response(
              JSON.stringify({
                id: 'ORDER-EMPTY-CAP-01',
                status: 'COMPLETED',
                intent: 'CAPTURE',
                purchase_units: [
                  {
                    reference_id: 'int_empty_caps_01',
                    amount: { value: '9.00', currency_code: 'USD' },
                    payee: { email_address: 'merchant@demo-store.local' },
                    payments: {
                      captures: [], // EMPTY captures array
                    },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_empty_caps_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_empty_caps',
        rationale: 'Empty captures test',
        provenance: { sources: [{ kind: 'user', ref: 'msg_empty_caps', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const capRes = await captureApprovedOrder({
        intentId: 'int_empty_caps_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:05:00Z',
      });

      expect(capRes.status).toBe('FAILED');
      expect(capRes.refusalReason).toBe('RECONCILIATION_FAILED');

      // Assert NO ORDER_CAPTURED audit event is recorded
      const capturedAudit = db.prepare("SELECT seq FROM audit_events WHERE type = 'ORDER_CAPTURED' AND ref = ?").get('int_empty_caps_01');
      expect(capturedAudit).toBeUndefined();

      // Assert reservation is released
      const spend = mandateService.getSpend('mnd_hardened_01');
      expect(spend.reserved_minor).toBe(0);
      expect(spend.captured_minor).toBe(0);

      // Assert status in database is FAILED, not CAPTURING or CAPTURED
      const row = db.prepare('SELECT status, capture_id FROM executed_intents WHERE intent_id = ?').get('int_empty_caps_01') as { status: string; capture_id: string | null };
      expect(row.status).toBe('FAILED');
      expect(row.capture_id).toBeNull();
    });

    it('getOrder throwing an error during reconciliation releases reservation and does NOT leave intent stranded in CAPTURING', async () => {
      let recGetOrderCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_ac14_err',
        clientSecret: 'sandbox_client_sec_ac14_err',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_ac14_err', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/capture') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                name: 'UNPROCESSABLE_ENTITY',
                message: 'The order has already been captured.',
                details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Order already captured' }],
              }),
              { status: 422 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-REC-ERR-01',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-REC-ERR-01' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-REC-ERR-01')) {
            recGetOrderCalls++;
            if (recGetOrderCalls === 1) {
              // Initial preflight getOrder succeeds so captureOrder is dispatched
              return new Response(
                JSON.stringify({
                  id: 'ORDER-REC-ERR-01',
                  status: 'APPROVED',
                  intent: 'CAPTURE',
                  purchase_units: [
                    {
                      reference_id: 'int_rec_err_01',
                      amount: { value: '9.00', currency_code: 'USD' },
                      payee: { email_address: 'merchant@demo-store.local' },
                    },
                  ],
                }),
                { status: 200 },
              );
            }
            // GET order throws a 500 network/server error during reconciliation
            return new Response('Internal Server Error', { status: 500 });
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_rec_err_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_rec_err',
        rationale: 'Reconciliation error test',
        provenance: { sources: [{ kind: 'user', ref: 'msg_rec_err', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const capRes = await captureApprovedOrder({
        intentId: 'int_rec_err_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:05:00Z',
      });

      expect(capRes.status).toBe('FAILED');
      expect(capRes.refusalReason).toBe('RECONCILIATION_FAILED');

      // Intent MUST NOT be stranded in CAPTURING
      const row = db.prepare('SELECT status FROM executed_intents WHERE intent_id = ?').get('int_rec_err_01') as { status: string };
      expect(row.status).toBe('FAILED');

      // Reservation MUST be released
      const spend = mandateService.getSpend('mnd_hardened_01');
      expect(spend.reserved_minor).toBe(0);
      expect(spend.captured_minor).toBe(0);
    });

    it('Preflight getOrder throwing an error transitions intent to FAILED and releases reservation atomically (never stranded in CAPTURING)', async () => {
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_preflight_err',
        clientSecret: 'sandbox_client_sec_preflight_err',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_preflight_err', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-PRE-ERR-01',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-PRE-ERR-01' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-PRE-ERR-01')) {
            // Verify atomic transition: status MUST be CAPTURING when calling PayPal
            const midRow = db.prepare('SELECT status FROM executed_intents WHERE intent_id = ?').get('int_pre_err_01') as { status: string } | undefined;
            if (midRow?.status !== 'CAPTURING') {
              throw new Error(`Atomic flip failed: expected CAPTURING but found ${midRow?.status}`);
            }
            // getOrder throws network/500 error before captureOrder is dispatched
            return new Response('Network Connection Dropped', { status: 503 });
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_pre_err_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_pre_err',
        rationale: 'Preflight network drop test',
        provenance: { sources: [{ kind: 'user', ref: 'msg_pre_err', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const capRes = await captureApprovedOrder({
        intentId: 'int_pre_err_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:05:00Z',
      });

      expect(capRes.status).toBe('FAILED');
      expect(capRes.refusalReason).toContain('GET_ORDER_FAILED');
      expect(capRes.refusalReason).toContain('Network Connection Dropped');

      // Intent MUST NOT be stranded in CAPTURING
      const row = db.prepare('SELECT status FROM executed_intents WHERE intent_id = ?').get('int_pre_err_01') as { status: string };
      expect(row.status).toBe('FAILED');

      // Reservation released atomically
      const spend = mandateService.getSpend('mnd_hardened_01');
      expect(spend.reserved_minor).toBe(0);
      expect(spend.captured_minor).toBe(0);
    });

    it('Double-approve idempotency: second captureApprovedOrder call returns stored CAPTURED state with zero extra PayPal calls', async () => {
      let captureOrderCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_double',
        clientSecret: 'sandbox_client_sec_double',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_double', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/capture') && init?.method === 'POST') {
            captureOrderCalls++;
            return new Response(
              JSON.stringify({
                id: 'CAP-DOUBLE-OK',
                status: 'COMPLETED',
                purchase_units: [{ payments: { captures: [{ id: 'CAP-DOUBLE-OK', status: 'COMPLETED' }] } }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-DOUBLE-01',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-DOUBLE-01' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-DOUBLE-01')) {
            return new Response(
              JSON.stringify({
                id: 'ORDER-DOUBLE-01',
                status: 'APPROVED',
                intent: 'CAPTURE',
                purchase_units: [
                  {
                    reference_id: 'int_double_01',
                    amount: { value: '9.00', currency_code: 'USD' },
                    payee: { email_address: 'merchant@demo-store.local' },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_double_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_double',
        rationale: 'Double capture idempotency test',
        provenance: { sources: [{ kind: 'user', ref: 'msg_double', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const firstCap = await captureApprovedOrder({
        intentId: 'int_double_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:05:00Z',
      });
      expect(firstCap.status).toBe('CAPTURED');
      expect(firstCap.captureId).toBe('CAP-DOUBLE-OK');
      expect(captureOrderCalls).toBe(1);

      // Second capture attempt (double-approve)
      const secondCap = await captureApprovedOrder({
        intentId: 'int_double_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:06:00Z',
      });
      expect(secondCap.status).toBe('CAPTURED');
      expect(secondCap.captureId).toBe('CAP-DOUBLE-OK');
      expect(captureOrderCalls).toBe(1); // ZERO extra PayPal calls!
    });

    it('STEP_UP approval timeout: unconfirmed STEP_UP intent past timeout transitions to EXPIRED, releases reservation, logs audit event, and preserves budget invariant with zero PayPal calls', async () => {
      let payPalCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_stepup_timeout',
        clientSecret: 'sandbox_client_sec_stepup_timeout',
        environment: 'sandbox',
        fetchFn: async () => {
          payPalCalls++;
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_stepup_timeout_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 5, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 4500,
        currency: 'USD',
        user_goal_ref: 'msg_stepup_timeout',
        rationale: 'Step-up timeout test',
        provenance: { sources: [{ kind: 'user', ref: 'msg_stepup_timeout', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      const stepUpRes = await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      expect(stepUpRes.verdict).toBe('STEP_UP');
      expect(stepUpRes.status).toBe('APPROVED');
      expect(stepUpRes.orderId).toBeUndefined();
      expect(payPalCalls).toBe(0);

      // Verify reservation is held
      const spendHeld = mandateService.getSpend('mnd_hardened_01');
      expect(spendHeld.reserved_minor).toBe(4500);
      expect(spendHeld.captured_minor).toBe(0);

      // Advance clock past step-up timeout (timeout is 300s -> +10 minutes = 600s)
      const tPast = '2026-10-20T08:10:00Z';
      const expired = sweepExpiredIntents(db, mandateService, tPast);
      expect(expired).toContain('int_stepup_timeout_01');

      // Verify reservation was released atomically (budget invariant preserved)
      const spendAfter = mandateService.getSpend('mnd_hardened_01');
      expect(spendAfter.reserved_minor).toBe(0);
      expect(spendAfter.captured_minor).toBe(0);

      // Verify database status is EXPIRED with refusal_reason STEP_UP_TIMEOUT
      const row = db.prepare('SELECT status, refusal_reason FROM executed_intents WHERE intent_id = ?').get('int_stepup_timeout_01') as { status: string; refusal_reason: string };
      expect(row.status).toBe('EXPIRED');
      expect(row.refusal_reason).toBe('STEP_UP_TIMEOUT');

      // Verify audit event INTENT_EXPIRED logged
      const auditEvent = db.prepare("SELECT * FROM audit_events WHERE ref = ? AND type = 'INTENT_EXPIRED'").get('int_stepup_timeout_01') as { payload: string } | undefined;
      expect(auditEvent).toBeDefined();
      const payload = JSON.parse(auditEvent!.payload);
      expect(payload.reason).toBe('STEP_UP_TIMEOUT');

      // Subsequent attempt to confirm step-up fails closed with zero PayPal calls
      const confirmRes = await executeApprovedStepUp({
        intentId: 'int_stepup_timeout_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: tPast,
      });
      expect(confirmRes.status).toBe('FAILED');
      expect(confirmRes.refusalReason).toBe('STEP_UP_TIMEOUT');
      expect(payPalCalls).toBe(0); // Zero PayPal calls
    });

    it('captureApprovedOrder on unconfirmed STEP_UP intent refuses immediately with zero getOrder and zero captureOrder calls', async () => {
      let getOrderCalls = 0;
      let captureOrderCalls = 0;
      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_unconf_stepup',
        clientSecret: 'sandbox_client_sec_unconf_stepup',
        environment: 'sandbox',
        fetchFn: async (url, _init) => {
          const urlStr = String(url);
          if (urlStr.includes('/capture')) {
            captureOrderCalls++;
          } else if (urlStr.includes('/v2/checkout/orders')) {
            getOrderCalls++;
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_unconfirmed_stepup_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 5, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 4500,
        currency: 'USD',
        user_goal_ref: 'msg_unconf_stepup',
        rationale: 'Unconfirmed step-up capture test',
        provenance: { sources: [{ kind: 'user', ref: 'msg_unconf_stepup', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      const stepUpRes = await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });
      expect(stepUpRes.verdict).toBe('STEP_UP');
      expect(stepUpRes.status).toBe('APPROVED');

      // Call captureApprovedOrder directly on this unconfirmed STEP_UP intent
      const capRes = await captureApprovedOrder({
        intentId: 'int_unconfirmed_stepup_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: t0,
      });

      expect(capRes.status).toBe('FAILED');
      expect(capRes.refusalReason).toBe('STEP_UP_NOT_CONFIRMED');
      expect(getOrderCalls).toBe(0); // Zero getOrder calls
      expect(captureOrderCalls).toBe(0); // Zero captureOrder calls

      // Reservation remains held pending user decision
      const res = mandateService.getReservation('int_unconfirmed_stepup_01');
      expect(res?.state).toBe('HELD');
    });

    it('observes status is atomically flipped to CAPTURING in database during PayPal getOrder preflight call', async () => {
      let statusObservedDuringGetOrder: string | undefined;

      const payPalClient = new PayPalClient({
        clientId: 'sandbox_client_id_observe_capturing',
        clientSecret: 'sandbox_client_sec_observe_capturing',
        environment: 'sandbox',
        fetchFn: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'tok_capturing_obs', expires_in: 3600 }), { status: 200 });
          }
          if (urlStr.includes('/capture') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'CAP-OBS-OK',
                status: 'COMPLETED',
                purchase_units: [{ payments: { captures: [{ id: 'CAP-OBS-OK', status: 'COMPLETED' }] } }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders') && !urlStr.includes('/capture') && init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                id: 'ORDER-OBS-01',
                status: 'CREATED',
                links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-OBS-01' }],
              }),
              { status: 201 },
            );
          }
          if (urlStr.includes('/v2/checkout/orders/ORDER-OBS-01') && (!init?.method || init.method === 'GET')) {
            // Directly observe SQLite status during the getOrder preflight call
            const midRow = db.prepare('SELECT status FROM executed_intents WHERE intent_id = ?').get('int_obs_capturing_01') as { status: string } | undefined;
            statusObservedDuringGetOrder = midRow?.status;

            return new Response(
              JSON.stringify({
                id: 'ORDER-OBS-01',
                status: 'APPROVED',
                intent: 'CAPTURE',
                purchase_units: [
                  {
                    reference_id: 'int_obs_capturing_01',
                    amount: { value: '9.00', currency_code: 'USD' },
                    payee: { email_address: 'merchant@demo-store.local' },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const proposal: PurchaseIntentProposal = {
        intent_id: 'int_obs_capturing_01',
        mandate_id: 'mnd_hardened_01',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'msg_obs_cap',
        rationale: 'Observe CAPTURING status test',
        provenance: { sources: [{ kind: 'user', ref: 'msg_obs_cap', trust: 'user' }] },
      };

      const t0 = '2026-10-20T08:00:00Z';
      await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: t0,
      });

      const capRes = await captureApprovedOrder({
        intentId: 'int_obs_capturing_01',
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: '2026-10-20T08:02:00Z',
      });

      expect(capRes.status).toBe('CAPTURED');
      // Assert that SQLite row status was strictly CAPTURING while inside getOrder
      expect(statusObservedDuringGetOrder).toBe('CAPTURING');
    });
  });
});

