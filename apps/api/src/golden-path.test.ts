import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, verifyAuditLedger } from '@mandatepay/audit';
import type { DatabaseConnection } from '@mandatepay/audit';
import { MandateService, initMandateTables } from './mandate-service.js';
import { executeGoldenPath, captureApprovedOrder, type StoreCatalogResolver } from './executor.js';
import { PayPalClient } from '@mandatepay/paypal';
import type { PurchaseIntentProposal } from '@mandatepay/schemas';

const TEST_HMAC_KEY = 'secret_golden_path_hmac_key_32_characters_long';

function setupDatabase(db: DatabaseConnection) {
  initMandateTables(db);

  // Setup merchants table & demo merchant
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      paypal_payee_ref TEXT NOT NULL,
      base_url TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_items (
      merchant_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_minor INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT NOT NULL DEFAULT '',
      hidden_instructions TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (merchant_id, sku)
    );
  `);

  db.prepare(`
    INSERT INTO merchants (id, name, paypal_payee_ref, base_url, created_at)
    VALUES ('mrc_demo_store', 'Demo Store (Apparel & Office Supplies)', 'sb-merchant-demo@business.example.com', 'https://demo-store.local', '2026-10-20T00:00:00Z')
    ON CONFLICT(id) DO NOTHING;
  `).run();

  db.prepare(`
    INSERT INTO catalog_items (merchant_id, sku, name, category, price_minor, currency, description)
    VALUES 
      ('mrc_demo_store', 'SKU-PEN-PACK', 'Gel Pen 10-Pack', 'office_supplies', 900, 'USD', 'Smooth-flowing gel pens'),
      ('mrc_demo_store', 'SKU-NOTEBOOK', 'Executive Hardcover Notebook', 'office_supplies', 1400, 'USD', 'Premium journal'),
      ('mrc_demo_store', 'SKU-STAND-DESK', 'Motorized Standing Desk', 'office_supplies', 32000, 'USD', 'Adjustable desk')
    ON CONFLICT(merchant_id, sku) DO NOTHING;
  `).run();
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

describe('Golden Path End-to-End (Task T-007, AC-1, FR-12..15, FR-26)', () => {
  let db: DatabaseConnection;
  let mandateService: MandateService;
  let catalogResolver: StoreCatalogResolver;
  let payPalClient: PayPalClient;

  beforeEach(() => {
    db = openDb(':memory:');
    setupDatabase(db);
    catalogResolver = createCatalogResolver(db);

    const fixedTime = '2026-10-20T08:00:00Z';
    mandateService = new MandateService(db, TEST_HMAC_KEY, () => fixedTime);

    // Create & activate Demo Mandate
    mandateService.createDraft({
      mandate_id: 'mnd_demo_001',
      owner_id: 'usr_demo',
      agent_id: 'agt_shopper_1',
      currency: 'USD',
      valid_from: '2026-10-20T00:00:00Z',
      valid_until: '2026-10-20T20:00:00Z',
      total_budget_minor: 20000, // $200.00
      per_txn_limit_minor: 8000,  // $80.00
      auto_approve_limit_minor: 3000, // $30.00
      max_txns_per_hour: 3,
      allowed_merchants: ['mrc_demo_store'],
      allowed_categories: ['office_supplies', 'books'],
      max_items_per_intent: 5,
      max_pending_approvals: 3,
      suspend_after_denies: 5,
      step_up: { channel: 'dashboard', timeout_seconds: 300 },
      risk: { step_up_threshold: 40, deny_threshold: 75 },
      wallet: { type: 'paypal_vault', ref: 'pt_sandbox_vault_shopper' },
      created_at: '2026-10-20T00:00:00Z',
    });
    mandateService.activate('mnd_demo_001');

    // In-memory order store for high-fidelity PayPal mock
    const ordersMap = new Map<string, { id: string; status: string; intent: string; purchase_units: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> }>();

    // PayPal Client using high-fidelity Sandbox Orders v2 mock fetcher
    payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_t007',
      clientSecret: 'sandbox_client_sec_t007',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(
            JSON.stringify({ access_token: 'sandbox_tok_golden_path', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (urlStr.includes('/capture') && init?.method === 'POST') {
          const captureId = `CAPTURE-SANDBOX-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
          return new Response(
            JSON.stringify({
              id: captureId,
              status: 'COMPLETED',
              amount: { currency_code: 'USD', value: '9.00' },
              purchase_units: [{ payments: { captures: [{ id: captureId, status: 'COMPLETED' }] } }],
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (urlStr.includes('/v2/checkout/orders') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          const orderId = `ORDER-SANDBOX-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
          const orderObj = {
            id: orderId,
            status: 'APPROVED',
            intent: body.intent,
            purchase_units: body.purchase_units,
            links: [
              { href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, rel: 'approve', method: 'GET' },
              { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`, rel: 'capture', method: 'POST' },
            ],
          };
          ordersMap.set(orderId, orderObj);
          return new Response(
            JSON.stringify(orderObj),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const matchOrder = urlStr.match(/\/v2\/checkout\/orders\/([^/?]+)/);
        if (matchOrder && matchOrder[1] && (!init || init.method === 'GET' || !init.method)) {
          const ord = ordersMap.get(matchOrder[1]);
          if (ord) {
            return new Response(JSON.stringify(ord), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
        }
        return new Response('Not Found', { status: 404 });
      },
    });
  });

  it('AC-1: Happy path executes end-to-end, captures order, and generates >= 5 linked audit events', async () => {
    const proposal: PurchaseIntentProposal = {
      intent_id: 'int_golden_happy_01',
      mandate_id: 'mnd_demo_001',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_shopper_pen_request',
      rationale: 'User asked for a pack of pens for office notes.',
      provenance: {
        sources: [
          { kind: 'user', ref: 'msg_shopper_pen_request', trust: 'user' },
          { kind: 'web', ref: 'https://demo-store.local/p/SKU-PEN-PACK', trust: 'untrusted_web' },
        ],
      },
    };

    const result = await executeGoldenPath({
      proposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: '2026-10-20T08:05:00Z',
    });

    // 1. Verdict & Plan B Decision assertions
    expect(result.verdict).toBe('ALLOW');
    expect(result.status).toBe('AWAITING_PAYER_APPROVAL');
    expect(result.approveUrl).toBeDefined();
    expect(result.orderId).toMatch(/^ORDER-SANDBOX-[A-Z0-9]+$/);
    expect(result.decision.verdict).toBe('ALLOW');
    expect(result.decision.reason_codes).toContain('APPROVED');
    expect(result.decision.verified_total_minor).toBe(900);

    // Policy trace checks: P-00, P-03, P-04, P-07 all pass
    const traceRules = result.decision.policy_trace.map((t) => t.rule);
    expect(traceRules).toContain('P-00');
    expect(traceRules).toContain('P-03');
    expect(traceRules).toContain('P-04');
    expect(traceRules).toContain('P-07');
    expect(traceRules).toContain('P-08');

    // 2. Reservation state before capture is HELD (FR-33, AC-12)
    const spendBefore = mandateService.getSpend('mnd_demo_001');
    expect(spendBefore.reserved_minor).toBe(900);
    expect(spendBefore.captured_minor).toBe(0);

    // 3. Plan B Payer Approval & Capture step (AC-1)
    const capRes = await captureApprovedOrder({
      intentId: proposal.intent_id,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      now: '2026-10-20T08:06:00Z',
    });

    expect(capRes.status).toBe('CAPTURED');
    expect(capRes.captureId).toMatch(/^CAPTURE-SANDBOX-[A-Z0-9]+$/);

    // 4. Reservation & Spend accounting after capture
    const spendAfter = mandateService.getSpend('mnd_demo_001');
    expect(spendAfter.captured_minor).toBe(900); // Shifted from reserved to captured
    expect(spendAfter.reserved_minor).toBe(0);

    // 5. Audit chain validation: shows >= 6 linked events for execution (AC-1)
    const chainVerify = verifyAuditLedger(db);
    expect(chainVerify.valid).toBe(true);
    expect(chainVerify.count).toBeGreaterThanOrEqual(6);
  });

  it('Denies out-of-limit intent without making any PayPal call', async () => {
    // Standing Desk is $320.00 (32000 cents), exceeding per-txn limit of $80.00 (8000 cents)
    const overLimitProposal: PurchaseIntentProposal = {
      intent_id: 'int_over_limit_99',
      mandate_id: 'mnd_demo_001',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-STAND-DESK', qty: 1, claimed_unit_price_minor: 32000 }],
      claimed_total_minor: 32000,
      currency: 'USD',
      user_goal_ref: 'msg_desk_request',
      rationale: 'User requested standing desk.',
      provenance: {
        sources: [{ kind: 'user', ref: 'msg_desk_request', trust: 'user' }],
      },
    };

    const result = await executeGoldenPath({
      proposal: overLimitProposal,
      payPalClient,
      mandateService,
      catalogResolver,
      db,
      hmacKey: TEST_HMAC_KEY,
      now: '2026-10-20T08:10:00Z',
    });

    expect(result.verdict).toBe('DENY');
    expect(result.status).toBe('DENIED');
    expect(result.decision.reason_codes).toContain('OVER_TXN_LIMIT');
    expect(result.orderId).toBeUndefined();
    expect(result.captureId).toBeUndefined();

    // Spend remains 0
    expect(mandateService.getSpend('mnd_demo_001').captured_minor).toBe(0);
    expect(mandateService.getSpend('mnd_demo_001').reserved_minor).toBe(0);
  });

  it('20/20 Reliability Gate: Achieves 100% success across 20 consecutive golden path executions (product.md §7)', async () => {
    const totalRuns = 20;
    const executionResults = [];

    for (let i = 1; i <= totalRuns; i++) {
      const intentId = `int_golden_run_${String(i).padStart(2, '0')}`;
      const proposal: PurchaseIntentProposal = {
        intent_id: intentId,
        mandate_id: 'mnd_demo_001',
        merchant_ref: 'mrc_demo_store',
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: `msg_run_${i}`,
        rationale: `Automated golden path run #${i}`,
        provenance: {
          sources: [{ kind: 'user', ref: `msg_run_${i}`, trust: 'user' }],
        },
      };

      const res = await executeGoldenPath({
        proposal,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        hmacKey: TEST_HMAC_KEY,
        now: `2026-10-20T08:${String(i).padStart(2, '0')}:00Z`,
      });

      expect(res.verdict).toBe('ALLOW');
      expect(res.status).toBe('AWAITING_PAYER_APPROVAL');
      expect(res.orderId).toBeDefined();

      const capRes = await captureApprovedOrder({
        intentId,
        payPalClient,
        mandateService,
        catalogResolver,
        db,
        now: `2026-10-20T08:${String(i).padStart(2, '0')}:30Z`,
      });

      expect(capRes.status).toBe('CAPTURED');
      expect(capRes.captureId).toBeDefined();
      executionResults.push(capRes);
    }

    // 20 out of 20 runs must succeed
    expect(executionResults).toHaveLength(20);
    const successCount = executionResults.filter((r) => r.status === 'CAPTURED').length;
    expect(successCount).toBe(20);

    // Final spend: 20 * $9.00 = $180.00 (18000 cents <= $200.00 total budget)
    const finalSpend = mandateService.getSpend('mnd_demo_001');
    expect(finalSpend.captured_minor).toBe(18000);
    expect(finalSpend.reserved_minor).toBe(0);

    // Full ledger integrity check verifies without gaps or forks across all runs
    const auditRes = verifyAuditLedger(db);
    expect(auditRes.valid).toBe(true);
    // 2 setup events + 20 runs * 4 events = 82 total cryptographic events
    expect(auditRes.count).toBeGreaterThanOrEqual(80);
  });
});
