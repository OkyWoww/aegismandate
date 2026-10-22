/**
 * AegisMandate Demo Reset Script (Task T-018)
 *
 * Resets the demo database cleanly to base seed state for mnd_demo_001.
 * Preserves pnpm seed unchanged for smoke and live-e2e tests.
 */

import 'dotenv/config';
import { runDemoReset, type DemoSeedOptions } from '../apps/api/src/demo-seed.js';
import { DEMO_STEP_UP_TIMEOUT_SECONDS } from './demo-config.js';

export { runDemoReset, type DemoSeedOptions };

async function main() {
  console.log('='.repeat(70));
  console.log(' AEGIS_MANDATE DEMO DATABASE RESET (Task T-018)');
  console.log('='.repeat(70));

  const result = runDemoReset({ stepUpTimeoutSeconds: DEMO_STEP_UP_TIMEOUT_SECONDS });

  console.log(`[DB] Target database reset: ${result.dbPath}`);
  console.log(`[Mandate] Seeded active Demo Mandate (${result.mandateId})`);
  console.log(`  - Total Budget: $${(result.totalBudgetMinor / 100).toFixed(2)} (${result.totalBudgetMinor} minor)`);
  console.log('='.repeat(70));
  console.log(' Demo database reset completed successfully.');
  console.log('='.repeat(70));
}

if (process.argv[1]?.includes('demo-reset.ts')) {
  main().catch((err) => {
    console.error('[Demo Reset Error]:', err);
    process.exit(1);
  });
}
