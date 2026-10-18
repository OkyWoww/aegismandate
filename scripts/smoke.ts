/**
 * MandatePay End-to-End Automated Smoke Verification Suite (Task T-016)
 *
 * Verifies full HTTP Control Plane lifecycle over ephemeral services:
 * 1. GET  /health -> Service liveness probe
 * 2. GET  /v1/mandates/:id -> Seed integrity & active mandate retrieval
 * 3. POST /v1/intents/propose -> In-mandate purchase (ALLOW) created & routed to buyer approval
 * 4. POST /v1/intents/propose & /approve -> Step-up purchase (STEP_UP) authorized & routed to buyer approval
 * 5. GET  /v1/audit/verify -> SHA-256 cryptographic audit ledger verification
 *
 * Guarantees zero orphaned processes and deterministic cleanup.
 * Aligned strictly with Plan B (FR-26, FR-34, FR-38): Stops cleanly at AWAITING_PAYER_APPROVAL + approve_url.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../packages/audit/src/index.js';
import { runSeed } from '../apps/stores/src/index.js';
import { startServer } from '../apps/api/src/index.js';

interface SmokeStepResult {
  step: number;
  name: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  details: string;
}

const SMOKE_PORT = Number(process.env.SMOKE_PORT || 3099);
const SMOKE_HOST = '127.0.0.1';
const SMOKE_DB_PATH = path.resolve(process.cwd(), './data/smoke-test.db');
const HMAC_KEY = 'mandatepay_demo_hmac_secret_key_default_32chars_for_local_testing';
const BASE_URL = `http://${SMOKE_HOST}:${SMOKE_PORT}`;

function cleanupTempDb() {
  const filesToClean = [
    SMOKE_DB_PATH,
    `${SMOKE_DB_PATH}-wal`,
    `${SMOKE_DB_PATH}-shm`,
  ];
  for (const file of filesToClean) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

async function runSmokeSuite(): Promise<boolean> {
  const startTime = Date.now();
  const results: SmokeStepResult[] = [];

  const clientId = process.env['PAYPAL_CLIENT_ID'];
  const isMock = !clientId || clientId.startsWith('sandbox_client_id_dev') || process.env['PAYPAL_MOCK'] === 'true';
  const modeLabel = isMock ? 'MODE: MOCK' : 'MODE: LIVE SANDBOX';

  console.log('='.repeat(80));
  console.log(` MANDATEPAY AUTOMATED SMOKE VERIFIER (T-016) — ${modeLabel}`);
  console.log('='.repeat(80));
  console.log(`[Execution Mode]                   ${modeLabel}`);
  console.log(`[Config] Target Ephemeral Endpoint: ${BASE_URL}`);
  console.log(`[Config] Isolated SQLite DB:       ${SMOKE_DB_PATH}`);
  console.log('-'.repeat(80));

  // Pre-cleanup and directory initialization
  cleanupTempDb();
  const dbDir = path.dirname(SMOKE_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Seed isolated DB with demo merchants, catalog, and active mandate
  runSeed({
    dbPath: SMOKE_DB_PATH,
    hmacKey: HMAC_KEY,
  });

  // Boot ephemeral Fastify server
  const { app } = await startServer({
    port: SMOKE_PORT,
    host: SMOKE_HOST,
    dbPath: SMOKE_DB_PATH,
    hmacKey: HMAC_KEY,
    logger: false,
  });

  let allPassed = true;

  try {
    // ------------------------------------------------------------------------
    // Step 1: Health Probe
    // ------------------------------------------------------------------------
    const t1Start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const body = (await res.json()) as { status: string; timestamp: string };
      if (res.status === 200 && body.status === 'OK') {
        results.push({
          step: 1,
          name: 'Health Check Probe (GET /health)',
          status: 'PASS',
          durationMs: Date.now() - t1Start,
          details: `HTTP 200 OK — status="${body.status}", server_ts=${body.timestamp}`,
        });
      } else {
        throw new Error(`Unexpected response: HTTP ${res.status} ${JSON.stringify(body)}`);
      }
    } catch (err) {
      allPassed = false;
      results.push({
        step: 1,
        name: 'Health Check Probe (GET /health)',
        status: 'FAIL',
        durationMs: Date.now() - t1Start,
        details: String(err),
      });
    }

    // ------------------------------------------------------------------------
    // Step 2: Seed Check & Mandate Retrieval
    // ------------------------------------------------------------------------
    const t2Start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/v1/mandates/mnd_demo_001`);
      const body = (await res.json()) as {
        mandate?: { mandate_id: string; status: string; total_budget_minor: number; currency: string };
        spend?: { remaining_minor: number };
      };
      if (
        res.status === 200 &&
        body.mandate?.mandate_id === 'mnd_demo_001' &&
        body.mandate.status === 'ACTIVE'
      ) {
        const budget = (body.mandate.total_budget_minor / 100).toFixed(2);
        results.push({
          step: 2,
          name: 'Mandate Retrieval (GET /v1/mandates/mnd_demo_001)',
          status: 'PASS',
          durationMs: Date.now() - t2Start,
          details: `HTTP 200 OK — status=${body.mandate.status}, budget=$${budget} ${body.mandate.currency}`,
        });
      } else {
        throw new Error(`Invalid mandate response: HTTP ${res.status} ${JSON.stringify(body)}`);
      }
    } catch (err) {
      allPassed = false;
      results.push({
        step: 2,
        name: 'Mandate Retrieval (GET /v1/mandates/mnd_demo_001)',
        status: 'FAIL',
        durationMs: Date.now() - t2Start,
        details: String(err),
      });
    }

    // ------------------------------------------------------------------------
    // Step 3: Propose ALLOW Intent & Verify Awaiting Approval + HELD Reservation
    // ------------------------------------------------------------------------
    const t3Start = Date.now();
    try {
      const allowIntentId = `int_smoke_allow_${Date.now()}`;
      const allowPayload = {
        intent_id: allowIntentId,
        mandate_id: 'mnd_demo_001',
        merchant_ref: 'mrc_demo_store',
        items: [
          {
            sku: 'SKU-PEN-PACK',
            qty: 1,
            claimed_unit_price_minor: 900,
          },
        ],
        claimed_total_minor: 900,
        currency: 'USD',
        user_goal_ref: 'smoke_goal_01',
        rationale: 'Smoke test automated pen purchase for office supply',
        provenance: {
          sources: [{ kind: 'user', ref: 'smoke_test_msg_01', trust: 'user' }],
        },
      };

      const res = await fetch(`${BASE_URL}/v1/intents/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allowPayload),
      });
      const body = (await res.json()) as {
        verdict: string;
        intent_id: string;
        status: string;
        order_id?: string;
        approve_url?: string;
      };

      if (
        res.status === 200 &&
        body.verdict === 'ALLOW' &&
        body.status === 'AWAITING_PAYER_APPROVAL' &&
        body.order_id &&
        body.approve_url
      ) {
        // Assert reservation state is HELD in database
        const db = openDb(SMOKE_DB_PATH);
        const reservation = db
          .prepare('SELECT state, amount_minor FROM reservations WHERE intent_id = ?')
          .get(allowIntentId) as { state: string; amount_minor: number } | undefined;
        db.close();

        if (reservation?.state !== 'HELD') {
          throw new Error(`Expected reservation state HELD but found ${reservation?.state}`);
        }

        results.push({
          step: 3,
          name: 'ALLOW Intent Creation & Buyer Approval Routing (POST /v1/intents/propose)',
          status: 'PASS',
          durationMs: Date.now() - t3Start,
          details: `HTTP 200 OK — verdict=ALLOW, status=AWAITING_PAYER_APPROVAL, order_id=${body.order_id}, approve_url=${body.approve_url}, reservation=HELD`,
        });
      } else {
        throw new Error(`Unexpected propose result: HTTP ${res.status} ${JSON.stringify(body)}`);
      }
    } catch (err) {
      allPassed = false;
      results.push({
        step: 3,
        name: 'ALLOW Intent Creation & Buyer Approval Routing (POST /v1/intents/propose)',
        status: 'FAIL',
        durationMs: Date.now() - t3Start,
        details: String(err),
      });
    }

    // ------------------------------------------------------------------------
    // Step 4: Propose STEP_UP Intent & Owner Authorization
    // ------------------------------------------------------------------------
    const t4Start = Date.now();
    try {
      const stepUpIntentId = `int_smoke_stepup_${Date.now()}`;
      const stepUpPayload = {
        intent_id: stepUpIntentId,
        mandate_id: 'mnd_demo_001',
        merchant_ref: 'mrc_demo_store',
        items: [
          {
            sku: 'SKU-DESK-LAMP',
            qty: 1,
            claimed_unit_price_minor: 4500,
          },
        ],
        claimed_total_minor: 4500,
        currency: 'USD',
        user_goal_ref: 'smoke_goal_02',
        rationale: 'Smoke test automated desk lamp purchase requiring step-up approval',
        provenance: {
          sources: [{ kind: 'user', ref: 'smoke_test_msg_02', trust: 'user' }],
        },
      };

      // 4a: Propose
      const propRes = await fetch(`${BASE_URL}/v1/intents/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stepUpPayload),
      });
      const propBody = (await propRes.json()) as {
        verdict: string;
        intent_id: string;
        status: string;
      };

      if (propRes.status !== 200 || propBody.verdict !== 'STEP_UP') {
        throw new Error(`Propose did not yield STEP_UP: HTTP ${propRes.status} ${JSON.stringify(propBody)}`);
      }

      // 4b: Approve by owner
      const appRes = await fetch(`${BASE_URL}/v1/intents/${propBody.intent_id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const appBody = (await appRes.json()) as {
        status: string;
        order_id?: string;
        approve_url?: string;
      };

      if (
        appRes.status === 200 &&
        appBody.status === 'AWAITING_PAYER_APPROVAL' &&
        appBody.order_id &&
        appBody.approve_url
      ) {
        // Assert reservation state is HELD in database
        const db = openDb(SMOKE_DB_PATH);
        const reservation = db
          .prepare('SELECT state, amount_minor FROM reservations WHERE intent_id = ?')
          .get(stepUpIntentId) as { state: string; amount_minor: number } | undefined;
        db.close();

        if (reservation?.state !== 'HELD') {
          throw new Error(`Expected reservation state HELD but found ${reservation?.state}`);
        }

        results.push({
          step: 4,
          name: 'STEP_UP Intent Propose & Owner Authorization (POST /approve)',
          status: 'PASS',
          durationMs: Date.now() - t4Start,
          details: `HTTP 200 OK — STEP_UP authorized, status=AWAITING_PAYER_APPROVAL, order_id=${appBody.order_id}, approve_url=${appBody.approve_url}, reservation=HELD`,
        });
      } else {
        throw new Error(`Approval failed: HTTP ${appRes.status} ${JSON.stringify(appBody)}`);
      }
    } catch (err) {
      allPassed = false;
      results.push({
        step: 4,
        name: 'STEP_UP Intent Propose & Owner Authorization (POST /approve)',
        status: 'FAIL',
        durationMs: Date.now() - t4Start,
        details: String(err),
      });
    }

    // ------------------------------------------------------------------------
    // Step 5: Cryptographic Audit Ledger Verification
    // ------------------------------------------------------------------------
    const t5Start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/v1/audit/verify`);
      const body = (await res.json()) as {
        valid: boolean;
        count: number;
        broken_at_seq: number | null;
        reason: string | null;
      };

      if (res.status === 200 && body.valid === true && body.count > 0 && body.broken_at_seq === null) {
        results.push({
          step: 5,
          name: 'Audit Ledger Chain Verification (GET /v1/audit/verify)',
          status: 'PASS',
          durationMs: Date.now() - t5Start,
          details: `HTTP 200 OK — SHA-256 chain valid, total_events=${body.count}, broken_seq=null`,
        });
      } else {
        throw new Error(`Ledger integrity check failed: HTTP ${res.status} ${JSON.stringify(body)}`);
      }
    } catch (err) {
      allPassed = false;
      results.push({
        step: 5,
        name: 'Audit Ledger Chain Verification (GET /v1/audit/verify)',
        status: 'FAIL',
        durationMs: Date.now() - t5Start,
        details: String(err),
      });
    }
  } finally {
    // Graceful teardown
    console.log('[Teardown] Shutting down ephemeral server and removing test database...');
    await app.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    cleanupTempDb();
  }

  // Print Summary Table
  const totalDuration = Date.now() - startTime;
  console.log('\n' + '='.repeat(80));
  console.log(' END-TO-END SMOKE TEST RESULTS');
  console.log('='.repeat(80));
  console.log(
    '#'.padEnd(4) +
      'Status'.padEnd(10) +
      'Step Name'.padEnd(46) +
      'Latency'.padEnd(10) +
      'Details',
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    const symbol = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
    console.log(
      String(r.step).padEnd(4) +
        symbol.padEnd(10) +
        r.name.padEnd(46) +
        `${r.durationMs}ms`.padEnd(10) +
        r.details,
    );
  }

  console.log('='.repeat(80));
  const passCount = results.filter((r) => r.status === 'PASS').length;
  console.log(
    `Summary: ${passCount}/${results.length} checks passed in ${totalDuration}ms. Overall: ${
      allPassed ? 'ALL SYSTEMS OPERATIONAL (PASS)' : 'VERIFICATION FAILED'
    }`,
  );
  console.log('='.repeat(80) + '\n');

  return allPassed;
}

runSmokeSuite()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((err) => {
    console.error('[Fatal Smoke Suite Error]:', err);
    process.exit(1);
  });
