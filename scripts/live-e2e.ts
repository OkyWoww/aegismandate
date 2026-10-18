import 'dotenv/config';

/**
 * MandatePay Live Sandbox End-to-End Buyer Approval & Capture (Task T-017, T-029, Rule.md §65, Product.md §68)
 *
 * Implements automated PayPal Sandbox buyer approval via Playwright,
 * followed by Control Plane capture execution and audit trail verification.
 * Supports 3 distinct scenarios:
 * 1. Single-Item In-Mandate Auto-Approve (Gel Pen 10-Pack, $9.00)
 * 2. STEP_UP Human Approval Flow with Cryptographic Payload-Hash Binding (Architect LED Desk Lamp, $45.00)
 * 3. Multi-Item In-Mandate Auto-Approve (Gel Pen 10-Pack + Notebook, $23.00)
 *
 * Guardrail 6:
 * If sandbox buyer credentials, Playwright, or network are unavailable:
 * Reports "NOT RUN: <reason>" cleanly.
 * Strictly redacts OAuth tokens and payer email addresses.
 * Mock runs print "MOCK" and never count as live evidence.
 */

import fs from 'node:fs';
import path from 'node:path';
import type * as Playwright from 'playwright';
import { openDb } from '../packages/audit/src/index.js';
import { runSeed } from '../apps/stores/src/index.js';
import { startServer } from '../apps/api/src/index.js';

const E2E_PORT = Number(process.env.E2E_PORT || 3098);
const E2E_HOST = '127.0.0.1';
const E2E_DB_PATH = path.resolve(process.cwd(), './data/e2e-live-test.db');
const HMAC_KEY = 'mandatepay_demo_hmac_secret_key_default_32chars_for_local_testing';
const OWNER_TOKEN = process.env['OWNER_TOKEN'] || '';
if (!OWNER_TOKEN || OWNER_TOKEN.length < 32) {
  throw new Error('OWNER_TOKEN env variable must be configured with at least 32 characters');
}
process.env['OWNER_TOKEN'] = OWNER_TOKEN;
const BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;

function redactSensitive(str: string): string {
  return str
    .replace(/access_token['"]?\s*:\s*['"]?[a-zA-Z0-9_\-.]+['"]?/gi, 'access_token: "[REDACTED]"')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[REDACTED_EMAIL]');
}

interface ScenarioConfig {
  id: string;
  name: string;
  items: Array<{ sku: string; qty: number; claimed_unit_price_minor: number }>;
  claimedTotalMinor: number;
  expectedVerdict: 'ALLOW' | 'STEP_UP';
  requiresHumanApproval: boolean;
}

const SCENARIOS: Record<string, ScenarioConfig> = {
  single: {
    id: 'SCENARIO-1-SINGLE',
    name: 'Single-Item In-Mandate Auto-Approve ($9.00 Pen Pack)',
    items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 }],
    claimedTotalMinor: 900,
    expectedVerdict: 'ALLOW',
    requiresHumanApproval: false,
  },
  stepup: {
    id: 'SCENARIO-2-STEPUP',
    name: 'STEP_UP Human-in-the-loop Approval ($45.00 Desk Lamp)',
    items: [{ sku: 'SKU-DESK-LAMP', qty: 1, claimed_unit_price_minor: 4500 }],
    claimedTotalMinor: 4500,
    expectedVerdict: 'STEP_UP',
    requiresHumanApproval: true,
  },
  multi: {
    id: 'SCENARIO-3-MULTI',
    name: 'Multi-Item In-Mandate Auto-Approve ($23.00 Pen Pack + Notebook)',
    items: [
      { sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 900 },
      { sku: 'SKU-NOTEBOOK', qty: 1, claimed_unit_price_minor: 1400 },
    ],
    claimedTotalMinor: 2300,
    expectedVerdict: 'ALLOW',
    requiresHumanApproval: false,
  },
};

async function executeBuyerApproval(
  playwright: typeof Playwright,
  approveUrl: string,
  buyerEmail: string,
  buyerPassword: string,
) {
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`      [Navigation Retry ${attempt}/2]: Retrying PayPal approval page navigation...`);
        }
        await page.goto(approveUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        break;
      } catch (err: unknown) {
        if (attempt === 2) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`      [Navigation Timeout]: ${msg || 'Gateway delayed'}, retrying navigation once...`);
        await page.waitForTimeout(3000);
      }
    }
    await page.waitForTimeout(3000);
    console.log(`      Current URL: ${page.url()}`);
    console.log(`      Page title: ${await page.title()}`);

    // Cookie banner handling
    try {
      const acceptCookie = page.locator('#acceptAllButton, button:has-text("Accept Cookies"), #banner-accept');
      if (await acceptCookie.isVisible({ timeout: 2000 })) {
        await acceptCookie.click();
        await page.waitForTimeout(1000);
      }
    } catch {
      // no cookie banner
    }

    // Login form handling
    const emailSelector = '#email, input[type="email"], input[name="login_email"]';
    try {
      await page.waitForSelector(emailSelector, { timeout: 10000 });
    } catch {
      console.log('      Email selector not immediately found, checking page state...');
    }

    if (await page.locator(emailSelector).first().isVisible()) {
      console.log('      Filling buyer email credentials...');
      await page.locator(emailSelector).first().fill(buyerEmail);

      const nextBtn = page.locator('#btnNext, button:has-text("Next")');
      if (await nextBtn.isVisible({ timeout: 2000 })) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
      }

      const pwdSelector = '#password, input[type="password"], input[name="login_password"]';
      await page.waitForSelector(pwdSelector, { timeout: 15000 });
      console.log('      Filling buyer password...');
      await page.locator(pwdSelector).first().fill(buyerPassword);

      const loginBtn = page.locator('#btnLogin, button:has-text("Log In")');
      await loginBtn.first().click();
      console.log('      Submitted login credentials, awaiting redirect...');
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
      } catch {
        console.log('      [LoadState Note]: Continuing to check approval button selector...');
      }
      await page.waitForTimeout(4000);
    }

    console.log(`      Post-login URL: ${page.url()}`);

    const submitSelector = [
      '#payment-submit-btn',
      '[data-testid="submit-button"]',
      'button:has-text("Lanjutkan untuk Memeriksa Pesanan")',
      'button:has-text("Lanjutkan")',
      'button:has-text("Memeriksa Pesanan")',
      'button:has-text("Setuju & Bayar")',
      'button:has-text("Selesaikan Pembelian")',
      'button:has-text("Bayar Sekarang")',
      'button:has-text("Complete Purchase")',
      'button:has-text("Agree & Pay")',
      'button:has-text("Continue")',
      'button:has-text("Pay Now")',
    ].join(', ');

    console.log('      Waiting for approval consent button...');
    await page.waitForSelector(submitSelector, { timeout: 30000 });

    const submitBtn = page.locator(submitSelector).first();
    console.log('      Clicking approval consent button...');
    await submitBtn.click();
    await page.waitForTimeout(5000);

    try {
      const secondSubmit = page.locator(submitSelector).first();
      if (await secondSubmit.isVisible({ timeout: 4000 })) {
        console.log('      Clicking secondary confirmation button...');
        await secondSubmit.click();
        await page.waitForTimeout(4000);
      }
    } catch {
      // no second confirmation needed
    }

    console.log('      Buyer approval completed successfully.');
  } catch (pwErr) {
    const errScreenshotPath = path.resolve(process.cwd(), './data/e2e-error.png');
    try {
      await page.screenshot({ path: errScreenshotPath, fullPage: true });
      console.log(`      [Debug Screenshot saved]: ${errScreenshotPath}`);
      console.log(`      [Debug URL]: ${page.url()}`);
    } catch {
      // ignore screenshot errors
    }
    throw pwErr;
  } finally {
    await browser.close();
  }
}

async function runSingleScenario(
  scenario: ScenarioConfig,
  playwright: typeof Playwright,
  buyerEmail: string,
  buyerPassword: string,
) {
  console.log('\n' + '-'.repeat(80));
  console.log(` EXECUTING SCENARIO: ${scenario.name} [${scenario.id}]`);
  console.log('-'.repeat(80));

  const intentId = `int_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Step 1: Propose Intent via Control Plane API
  console.log('[1/5] Proposing purchase intent via Control Plane API...');
  const propRes = await fetch(`${BASE_URL}/v1/intents/propose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent_id: intentId,
      mandate_id: 'mnd_demo_001',
      merchant_ref: 'mrc_demo_store',
      items: scenario.items,
      claimed_total_minor: scenario.claimedTotalMinor,
      currency: 'USD',
      user_goal_ref: 'goal_e2e_live',
      rationale: `Live end-to-end sandbox verification for ${scenario.name}`,
      provenance: { sources: [{ kind: 'user', ref: 'goal_e2e_live', trust: 'user' }] },
    }),
  });

  const propBody = (await propRes.json()) as {
    verdict: string;
    intent_id: string;
    status: string;
    order_id?: string;
    approve_url?: string;
  };

  if (propBody.verdict !== scenario.expectedVerdict) {
    throw new Error(`Expected verdict ${scenario.expectedVerdict}, got: ${JSON.stringify(propBody)}`);
  }

  let finalApproveUrl: string;
  let finalOrderId: string;

  // Step 2: Handle STEP_UP human approval if applicable
  if (scenario.requiresHumanApproval) {
    console.log('[2/5] Handling STEP_UP approval flow with cryptographic expected_payload_hash binding...');
    if (propBody.status !== 'APPROVED' && propBody.status !== 'PENDING_APPROVAL') {
      throw new Error(`Expected APPROVED or PENDING_APPROVAL status for STEP_UP, got: ${JSON.stringify(propBody)}`);
    }

    // Fetch intent to retrieve cryptographic payload_hash
    const intentRes = await fetch(`${BASE_URL}/v1/intents/${intentId}`);
    if (intentRes.status !== 200) {
      throw new Error(`Failed to retrieve intent status: HTTP ${intentRes.status}`);
    }
    const intentData = (await intentRes.json()) as { payload_hash: string; status: string };
    if (!intentData.payload_hash) {
      throw new Error(`Missing payload_hash on pending STEP_UP intent ${intentId}`);
    }

    console.log(`      Retrieved payload_hash: ${intentData.payload_hash}`);
    console.log('      Executing owner approval via POST /v1/intents/:id/approve with OWNER_TOKEN...');

    const approveRes = await fetch(`${BASE_URL}/v1/intents/${intentId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OWNER_TOKEN}`,
      },
      body: JSON.stringify({
        expected_payload_hash: intentData.payload_hash,
      }),
    });

    const approveBody = (await approveRes.json()) as {
      status: string;
      order_id?: string;
      approve_url?: string;
    };

    if (approveRes.status !== 200 || !approveBody.approve_url || !approveBody.order_id) {
      throw new Error(`Human approval failed: HTTP ${approveRes.status} ${JSON.stringify(approveBody)}`);
    }

    console.log(`      Human Approval Succeeded! PayPal Order Created: ${approveBody.order_id}`);
    finalApproveUrl = approveBody.approve_url;
    finalOrderId = approveBody.order_id;
  } else {
    if (propBody.status !== 'AWAITING_PAYER_APPROVAL' || !propBody.approve_url || !propBody.order_id) {
      throw new Error(`Expected AWAITING_PAYER_APPROVAL with approve_url, got: ${JSON.stringify(propBody)}`);
    }
    finalApproveUrl = propBody.approve_url;
    finalOrderId = propBody.order_id;
    console.log(`      Order created: ${finalOrderId}`);
  }

  console.log(`      Approve URL:   ${finalApproveUrl}`);

  // Step 3: Automate Buyer Approval via Playwright
  console.log('[3/5] Automating buyer approval via Playwright headless browser...');
  await executeBuyerApproval(playwright, finalApproveUrl, buyerEmail, buyerPassword);

  // Step 4: Trigger Control Plane Capture
  console.log('[4/5] Triggering Control Plane capture flow (Authorized with OWNER_TOKEN)...');
  const capRes = await fetch(`${BASE_URL}/v1/intents/${intentId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({}),
  });

  const capBody = (await capRes.json()) as {
    status: string;
    order_id?: string;
    capture_id?: string;
  };

  if (capBody.status !== 'CAPTURED' || !capBody.capture_id) {
    throw new Error(`Capture failed: HTTP ${capRes.status} ${JSON.stringify(capBody)}`);
  }

  console.log(`      Authentic PayPal Capture ID: ${capBody.capture_id}`);

  // Step 5: Verify Cryptographic Audit Ledger
  console.log('[5/5] Verifying ORDER_CAPTURED row and ledger integrity...');
  const db = openDb(E2E_DB_PATH);
  const auditRow = db.prepare(
    `SELECT seq, ts, actor, type, ref, payload, prev_hash, hash FROM audit_events WHERE ref = ? AND type = 'ORDER_CAPTURED'`,
  ).get(intentId) as {
    seq: number;
    ts: string;
    actor: string;
    type: string;
    ref: string;
    payload: string;
    prev_hash: string;
    hash: string;
  } | undefined;
  db.close();

  if (!auditRow) {
    throw new Error(`Missing ORDER_CAPTURED audit row for intent ${intentId}`);
  }

  let parsedPayload: Record<string, unknown> = {};
  try {
    parsedPayload = JSON.parse(auditRow.payload);
  } catch {
    // keep raw
  }

  if (!parsedPayload.payee_ref) {
    throw new Error(`Critical violation: payee_ref missing from ORDER_CAPTURED audit payload: ${auditRow.payload}`);
  }

  const verifyRes = await fetch(`${BASE_URL}/v1/audit/verify`);
  if (verifyRes.status !== 200) {
    throw new Error(`Audit verify endpoint returned HTTP ${verifyRes.status}`);
  }
  const verifyBody = (await verifyRes.json()) as {
    valid: boolean;
    count: number;
    broken_seq: number | null;
  };

  if (verifyBody.valid !== true || verifyBody.broken_seq !== null) {
    throw new Error(`Audit ledger verification failed: valid=${verifyBody.valid}, broken_seq=${verifyBody.broken_seq}`);
  }

  console.log(`      Audit ledger valid: true (count=${verifyBody.count})`);
  console.log(`      payee_ref verified in ledger: ${parsedPayload.payee_ref}`);

  console.log('='.repeat(80));
  console.log(` SCENARIO COMPLETED (PASS): ${scenario.name}`);
  console.log(` Authentic Capture ID : ${capBody.capture_id}`);
  console.log(` Audit Event Ref      : ${intentId}`);
  console.log(` Audit Ledger Valid   : ${verifyBody.valid} (broken_seq=${verifyBody.broken_seq})`);
  console.log('='.repeat(80));

  return {
    scenarioId: scenario.id,
    intentId,
    captureId: capBody.capture_id,
    orderId: finalOrderId,
    auditRow,
    parsedPayload,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isMock = args.includes('--mock');

  if (isMock) {
    console.log('='.repeat(80));
    console.log(' MOCK: Running simulated E2E test (NOT VALID AS LIVE EVIDENCE)');
    console.log('='.repeat(80));
    process.exit(0);
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const buyerEmail = process.env.PAYPAL_BUYER_EMAIL;
  const buyerPassword = process.env.PAYPAL_BUYER_PASSWORD;

  if (!clientId || !clientSecret || clientId.startsWith('sandbox_client_id_dev')) {
    console.log('NOT RUN: PayPal Sandbox API credentials (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET) not configured in .env.');
    process.exit(0);
  }

  if (!buyerEmail || !buyerPassword) {
    console.log('NOT RUN: PayPal Sandbox buyer credentials (PAYPAL_BUYER_EMAIL, PAYPAL_BUYER_PASSWORD) not provided in .env.');
    process.exit(0);
  }

  let playwright: typeof Playwright | undefined;
  try {
    const moduleName = 'playwright';
    playwright = (await import(moduleName)) as typeof Playwright;
  } catch {
    console.log('NOT RUN: Playwright is not installed in dependencies.');
    process.exit(0);
  }

  // Parse target scenario: single (default), stepup, multi, or all
  const scenarioFlag = args.find((a) => a.startsWith('--scenario='))?.split('=')[1]
    || (args.includes('stepup') ? 'stepup' : args.includes('multi') ? 'multi' : args.includes('all') ? 'all' : 'single');

  console.log('='.repeat(80));
  console.log(' MANDATEPAY LIVE SANDBOX E2E VERIFICATION (PLAYWRIGHT BUYER APPROVAL)');
  console.log(` Target Scenario(s) : ${scenarioFlag.toUpperCase()}`);
  console.log(` Endpoint           : ${BASE_URL}`);
  console.log(` Buyer              : [REDACTED_EMAIL]`);
  console.log('='.repeat(80));

  // Initialize DB
  if (fs.existsSync(E2E_DB_PATH)) {
    try { fs.unlinkSync(E2E_DB_PATH); } catch { /* ignore */ }
  }
  const dbDir = path.dirname(E2E_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  runSeed({ dbPath: E2E_DB_PATH, hmacKey: HMAC_KEY });

  const { app } = await startServer({
    port: E2E_PORT,
    host: E2E_HOST,
    dbPath: E2E_DB_PATH,
    hmacKey: HMAC_KEY,
    logger: false,
  });

  try {
    const toExecute: ScenarioConfig[] = [];
    if (scenarioFlag === 'all') {
      toExecute.push(SCENARIOS.single, SCENARIOS.stepup, SCENARIOS.multi);
    } else if (SCENARIOS[scenarioFlag]) {
      toExecute.push(SCENARIOS[scenarioFlag]);
    } else {
      throw new Error(`Unknown scenario: ${scenarioFlag}. Valid: single, stepup, multi, all`);
    }

    const executed = [];
    for (const sc of toExecute) {
      const res = await runSingleScenario(sc, playwright, buyerEmail, buyerPassword);
      executed.push(res);
    }

    console.log('\n' + '='.repeat(80));
    console.log(' LIVE E2E VERIFICATION COMPLETED (PASS)');
    for (const res of executed) {
      console.log(` [${res.scenarioId}] Capture ID: ${res.captureId} | Intent: ${res.intentId}`);
    }
    console.log('='.repeat(80));
  } finally {
    await app.close();
    if (fs.existsSync(E2E_DB_PATH)) {
      try { fs.unlinkSync(E2E_DB_PATH); } catch { /* ignore */ }
    }
  }
}

main().catch((err: unknown) => {
  console.error('[E2E Live Error]:', redactSensitive(String(err)));
  if (err instanceof Error && 'cause' in err && err.cause) {
    console.error('[E2E Live Cause]:', err.cause);
  }
  process.exit(1);
});
