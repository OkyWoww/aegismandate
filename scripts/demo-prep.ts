/**
 * AegisMandate Demo Prep (video recording)
 *
 * One command: `pnpm demo:prep`
 *  1. Resets the demo database.
 *  2. Seeds deterministic activity (captured $9.00, blocked $500 attack, pending $45.00 STEP_UP lamp).
 *  3. Uses step_up.timeout_seconds = 900 (15 min) so the approval card cannot expire mid-recording.
 *
 * Start the API/web AFTER this script (the DB file is recreated), then approve within the window.
 */

import 'dotenv/config';
import { runDemoSeed } from '../apps/api/src/demo-seed.js';
import { DEMO_STEP_UP_TIMEOUT_SECONDS } from './demo-config.js';

async function main() {
  console.log('='.repeat(70));
  console.log(' AEGIS_MANDATE DEMO PREP (reset + seed, long step-up TTL)');
  console.log('='.repeat(70));

  const startedAt = Date.now();
  const result = await runDemoSeed({ stepUpTimeoutSeconds: DEMO_STEP_UP_TIMEOUT_SECONDS });
  const approxExpiry = new Date(startedAt + DEMO_STEP_UP_TIMEOUT_SECONDS * 1000).toISOString();

  console.log(`[DB] ${result.dbPath}`);
  console.log(`[Mandate] ${result.mandateId} (step-up TTL: ${DEMO_STEP_UP_TIMEOUT_SECONDS}s)`);
  console.log(`[STEP_UP] ${result.stepUpIntentId} expires at ~${approxExpiry}`);
  console.log(`[Audit Ledger] Valid: ${result.auditValid}, Total Events: ${result.auditEventsCount}`);
  console.log('='.repeat(70));
  console.log(' Demo prep complete. Start the stack (pnpm dev) and approve before expiry.');
  console.log('='.repeat(70));
}

if (process.argv[1]?.includes('demo-prep.ts')) {
  main().catch((err) => {
    console.error('[Demo Prep Error]:', err);
    process.exit(1);
  });
}
