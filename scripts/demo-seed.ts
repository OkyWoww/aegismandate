/**
 * AegisMandate Deterministic Demo Activity Seeder (Task T-018)
 *
 * Populates a deterministic demo scenario for the Impact Dashboard Hero:
 * - 1 Legitimate $9.00 (900 minor) Pen Pack intent captured via PayPal sandbox
 * - 1 Injected $500.00 (50000 minor) attack proposal blocked with verdict DENY (0 PayPal calls)
 * - 1 Borderline $45.00 (4500 minor) Desk Lamp proposal pending STEP_UP (reservation held, $146.00 remaining)
 * - Valid SHA-256 cryptographic audit ledger chain
 */

import 'dotenv/config';
import { runDemoSeed, type DemoSeedOptions, type DemoSeedResult } from '../apps/api/src/demo-seed.js';

export { runDemoSeed, type DemoSeedOptions, type DemoSeedResult };

async function main() {
  console.log('='.repeat(70));
  console.log(' AEGIS_MANDATE DEMO ACTIVITY SEED (Task T-018)');
  console.log('='.repeat(70));

  const result = await runDemoSeed();

  console.log(`[DB] Target database: ${result.dbPath}`);
  console.log(`[Mandate] ${result.mandateId}:`);
  console.log(`  - Total Budget:    $200.00 (20000 minor)`);
  console.log(`  - Captured Spend:  $${(result.capturedMinor / 100).toFixed(2)} (${result.capturedMinor} minor) [${result.capturedIntentId}]`);
  console.log(`  - Reserved:        $${(result.reservedMinor / 100).toFixed(2)} (${result.reservedMinor} minor) [${result.stepUpIntentId}]`);
  console.log(`  - Remaining:       $${(result.remainingMinor / 100).toFixed(2)} (${result.remainingMinor} minor)`);
  console.log(`[Blocked Attacks] Count: ${result.blockedCount}, Attempted: $${(result.blockedAttemptedMinor / 100).toFixed(2)} (${result.blockedAttemptedMinor} minor) [${result.deniedIntentId}]`);
  console.log(`[Audit Ledger] Valid: ${result.auditValid}, Total Events: ${result.auditEventsCount}`);
  console.log('='.repeat(70));
  console.log(' Demo activity seed completed successfully.');
  console.log('='.repeat(70));
}

if (process.argv[1]?.includes('demo-seed.ts')) {
  main().catch((err) => {
    console.error('[Demo Seed Error]:', err);
    process.exit(1);
  });
}
