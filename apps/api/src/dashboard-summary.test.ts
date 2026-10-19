/**
 * Integration Test Suite for Impact Dashboard Summary Endpoint (Task T-018)
 *
 * References:
 * - docs/specs/T-018-dashboard-spec.md §2 (Data Contract), §7 (Criteria 1, 2, 3, 4, 5, 9)
 * - specs/spec.md INV-8 (Budget invariant: captured_minor + reserved_minor <= total_budget_minor)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { openDb, verifyAuditLedger, type DatabaseConnection } from '@mandatepay/audit';
import { PayPalClient, createMockPayPalFetch } from '@mandatepay/paypal';
import { MandateService } from './mandate-service.js';
import { buildServer } from './server.js';
import { runDemoReset, runDemoSeed, createStoreCatalogResolver } from './demo-seed.js';

describe('Impact Dashboard Summary Backend (Task T-018 §2, §7 Criteria 1–5 & 9)', () => {
  const dbPath = './data/mandatepay.db';
  const hmacKey = 'mandatepay_demo_hmac_secret_key_default_32chars_for_local_testing';
  let db: DatabaseConnection;
  let server: FastifyInstance;

  async function bootServer() {
    db = openDb(dbPath);
    const catalogResolver = createStoreCatalogResolver(db);
    const mandateService = new MandateService(db, hmacKey);
    const payPalClient = new PayPalClient({
      clientId: 'sandbox_client_id_dev_mock',
      clientSecret: 'sandbox_client_secret_dev_mock',
      environment: 'sandbox',
      fetchFn: createMockPayPalFetch(),
    });

    server = await buildServer({
      db,
      mandateService,
      catalogResolver,
      payPalClient,
      hmacKey,
      ownerToken: 'test_owner_secret_token_at_least_32_chars_long!',
      agentToken: 'test_agent_secret_token_at_least_32_chars_long!',
    });
  }

  beforeEach(async () => {
    // Reset and seed demo state in-process (< 50ms)
    await runDemoSeed({ dbPath, hmacKey });
    await bootServer();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (db && db.isOpen()) {
      db.close();
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 1: Summary endpoint output equals direct SQL queries on the seeded DB
  // --------------------------------------------------------------------------
  it('Criterion 1: Summary endpoint output equals direct SQL queries on the seeded DB', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?mandate_id=mnd_demo_001',
    });

    expect(res.statusCode).toBe(200);
    const summary = JSON.parse(res.body);

    // Direct SQL queries on SQLite database
    const mandateRow = db
      .prepare('SELECT id, json FROM mandates WHERE id = ?')
      .get('mnd_demo_001') as { id: string; json: string };
    const mandateData = JSON.parse(mandateRow.json);

    const spendRow = db
      .prepare('SELECT captured_minor, reserved_minor FROM mandate_spend WHERE mandate_id = ?')
      .get('mnd_demo_001') as { captured_minor: number; reserved_minor: number };

    const denyCountRow = db
      .prepare("SELECT count(*) as count FROM executed_intents WHERE mandate_id = ? AND verdict = 'DENY'")
      .get('mnd_demo_001') as { count: number };

    const capturedCountRow = db
      .prepare("SELECT count(*) as count FROM executed_intents WHERE mandate_id = ? AND status = 'CAPTURED'")
      .get('mnd_demo_001') as { count: number };

    const lastAuditRow = db
      .prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1')
      .get() as { seq: number; hash: string };

    const auditLedger = verifyAuditLedger(db);

    // Assert exact equivalence between API output and raw SQL state
    expect(summary.mandate.id).toBe(mandateRow.id);
    expect(summary.mandate.currency).toBe(mandateData.currency);
    expect(summary.mandate.total_budget_minor).toBe(mandateData.total_budget_minor);
    expect(summary.mandate.captured_minor).toBe(spendRow.captured_minor);
    expect(summary.mandate.reserved_minor).toBe(spendRow.reserved_minor);
    expect(summary.mandate.remaining_minor).toBe(
      mandateData.total_budget_minor - spendRow.captured_minor - spendRow.reserved_minor,
    );

    expect(summary.blocked.count).toBe(denyCountRow.count);
    expect(summary.verified.count).toBe(capturedCountRow.count);
    expect(summary.verified.captured_total_minor).toBe(spendRow.captured_minor);

    expect(summary.audit.head_seq).toBe(lastAuditRow.seq);
    expect(summary.audit.head_hash).toBe(lastAuditRow.hash);
    expect(summary.audit.chain_valid).toBe(auditLedger.valid);
    expect(summary.audit.chain_valid).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Criterion 2: blocked.attempted_total_minor uses claimed_total_minor; malformed increments unknown_amount_count
  // --------------------------------------------------------------------------
  it('Criterion 2: blocked.attempted_total_minor uses claimed_total_minor even when verified_total_minor is null; malformed DENY increments unknown_amount_count', async () => {
    // 1. Initial state check: 1 blocked attack ($500.00 / 50000 minor)
    const res1 = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?mandate_id=mnd_demo_001',
    });
    const summary1 = JSON.parse(res1.body);
    expect(summary1.blocked.count).toBe(1);
    expect(summary1.blocked.attempted_total_minor).toBe(50000);
    expect(summary1.blocked.unknown_amount_count).toBe(0);

    // 2. Insert a malformed DENY proposal without claimed_total_minor (e.g. corrupt or missing payload)
    db.prepare(`
      INSERT INTO executed_intents (
        intent_id, mandate_id, merchant_ref, verdict, decision_json, status,
        payload_hash, proposal_json, refusal_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'int_test_malformed_deny',
      'mnd_demo_001',
      'mrc_evil_store',
      'DENY',
      '{}',
      'REJECTED',
      'hash_malformed_test',
      JSON.stringify({ intent_id: 'int_test_malformed_deny', rationale: 'Malformed without claimed_total_minor' }),
      'SCHEMA_VALIDATION_FAILED',
      '2026-10-20T10:05:00Z',
      '2026-10-20T10:05:00Z',
    );

    // 3. Query summary again
    const res2 = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?mandate_id=mnd_demo_001',
    });
    const summary2 = JSON.parse(res2.body);

    // blocked.count increased to 2
    expect(summary2.blocked.count).toBe(2);
    // attempted_total_minor remains 50000 (did NOT guess or invent numbers for the malformed intent)
    expect(summary2.blocked.attempted_total_minor).toBe(50000);
    // unknown_amount_count incremented to 1
    expect(summary2.blocked.unknown_amount_count).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Criteria 3 & 4: Invariants hold strictly: captured + reserved + remaining == total_budget & INV-8
  // --------------------------------------------------------------------------
  it('Criteria 3 & 4: Invariants hold strictly: captured + reserved + remaining === total_budget and captured + reserved <= total_budget (INV-8)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?mandate_id=mnd_demo_001',
    });
    const summary = JSON.parse(res.body);

    const { total_budget_minor, captured_minor, reserved_minor, remaining_minor } = summary.mandate;

    // Seeded exact numbers
    expect(captured_minor).toBe(900);      // $9.00 Pen Pack captured
    expect(reserved_minor).toBe(4500);     // $45.00 Desk Lamp pending STEP_UP
    expect(remaining_minor).toBe(14600);   // $146.00 remaining
    expect(total_budget_minor).toBe(20000); // $200.00 total budget

    // Criterion 3: captured + reserved + remaining === total_budget
    expect(captured_minor + reserved_minor + remaining_minor).toBe(total_budget_minor);

    // Criterion 4 & INV-8: captured + reserved <= total_budget
    expect(captured_minor + reserved_minor).toBeLessThanOrEqual(total_budget_minor);
  });

  // --------------------------------------------------------------------------
  // Criterion 5: blocked.paypal_calls === 0 and no PayPal order creation for DENY
  // --------------------------------------------------------------------------
  it('Criterion 5: blocked.paypal_calls is strictly 0 and DENY initiates zero PayPal interactions', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?mandate_id=mnd_demo_001',
    });
    const summary = JSON.parse(res.body);

    expect(summary.blocked.paypal_calls).toBe(0);

    // Verify in audit ledger that the denied intent 'int_demo_attack_500' has NO ORDER_CREATED event
    const attackOrderEvents = db
      .prepare("SELECT count(*) as count FROM audit_events WHERE ref = 'int_demo_attack_500' AND type = 'ORDER_CREATED'")
      .get() as { count: number };

    expect(attackOrderEvents.count).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Criterion 9: Idempotence of demo:reset and demo:seed
  // --------------------------------------------------------------------------
  it('Criterion 9: Running demo:reset && demo:seed twice is idempotent and yields the exact same summary state', async () => {
    // Close current server and DB connection before re-running reset
    await server.close();
    db.close();

    // Run 1: reset + seed in-process
    runDemoReset({ dbPath, hmacKey });
    await runDemoSeed({ dbPath, hmacKey });
    await bootServer();

    const res1 = await server.inject({ method: 'GET', url: '/v1/dashboard/summary?mandate_id=mnd_demo_001' });
    const summary1 = JSON.parse(res1.body);

    await server.close();
    db.close();

    // Run 2: reset + seed again in-process
    runDemoReset({ dbPath, hmacKey });
    await runDemoSeed({ dbPath, hmacKey });
    await bootServer();

    const res2 = await server.inject({ method: 'GET', url: '/v1/dashboard/summary?mandate_id=mnd_demo_001' });
    const summary2 = JSON.parse(res2.body);

    // Assert exact identical summary states across runs
    expect(summary1.mandate).toEqual(summary2.mandate);
    expect(summary1.blocked).toEqual(summary2.blocked);
    expect(summary1.verified).toEqual(summary2.verified);
    expect(summary1.audit.head_seq).toBe(summary2.audit.head_seq);
    expect(summary1.audit.chain_valid).toBe(true);
    expect(summary2.audit.chain_valid).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Audit Ledger Drawer route: GET /v1/audit/events?mandate_id=<id>&limit=50
  // --------------------------------------------------------------------------
  it('GET /v1/audit/events?mandate_id=<id>&limit=50 filters raw chain entries for the drawer', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/audit/events?mandate_id=mnd_demo_001&limit=50',
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThanOrEqual(data.events.length);

    // Each event must have hash-chain fields
    for (const ev of data.events) {
      expect(typeof ev.seq).toBe('number');
      expect(typeof ev.hash).toBe('string');
      expect(typeof ev.prev_hash).toBe('string');
      expect(typeof ev.type).toBe('string');
    }
  });
});
