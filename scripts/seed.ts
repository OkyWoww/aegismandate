/**
 * AegisMandate Deterministic Seed Script Runner (T-006)
 * References:
 * - specs/demo.md §1
 * - specs/spec.md §2 (FR-13), §3.1-3.2
 * - specs/tasks.md T-006
 * - rule.md §2.2 (Integer USD cents), NFR-6 (Relative mocked clocks)
 */

import 'dotenv/config';
import { openDb } from '../packages/audit/src/index.js';
import {
  runSeed,
  listMerchants,
  listCatalogItems,
} from '../apps/stores/src/index.js';

export { runSeed };

async function main() {
  console.log('='.repeat(70));
  console.log(' AEGIS_MANDATE DATABASE SEED (Task T-006)');
  console.log('='.repeat(70));

  const result = runSeed();

  console.log(`[DB] Target database: ${result.dbPath}`);
  console.log(`[Merchants] Seeded ${result.merchantsCount} merchants:`);
  const db = openDb(result.dbPath);
  const merchants = listMerchants(db);
  for (const m of merchants) {
    console.log(`  - ${m.id}: "${m.name}" (payee: ${m.paypal_payee_ref}, url: ${m.base_url})`);
  }

  console.log(`\n[Catalog] Seeded ${result.catalogItemsCount} items:`);
  const items = listCatalogItems(db);
  for (const item of items) {
    const formattedPrice = (item.price_minor / 100).toFixed(2);
    console.log(`  - [${item.merchant_id}] ${item.sku}: "${item.name}" - $${formattedPrice} (${item.price_minor} cents, ${item.category})`);
  }

  console.log(`\n[Mandate] Seeded active Demo Mandate (Relative-Clock 12h TTL):`);
  console.log(`  - ID: ${result.mandate.mandate_id}`);
  console.log(`  - Owner: ${result.mandate.owner_id} | Agent: ${result.mandate.agent_id}`);
  console.log(`  - Status: ${result.mandate.status}`);
  console.log(`  - Total Budget: $${(result.mandate.total_budget_minor / 100).toFixed(2)} (${result.mandate.total_budget_minor} cents)`);
  console.log(`  - Per-Txn Cap: $${(result.mandate.per_txn_limit_minor / 100).toFixed(2)} (${result.mandate.per_txn_limit_minor} cents)`);
  console.log(`  - Auto-Approve Limit: $${(result.mandate.auto_approve_limit_minor / 100).toFixed(2)} (${result.mandate.auto_approve_limit_minor} cents)`);
  console.log(`  - Valid From:  ${result.mandate.valid_from}`);
  console.log(`  - Valid Until: ${result.mandate.valid_until}`);
  console.log(`  - Signature:   ${result.mandate.signature}`);
  console.log('='.repeat(70));
  console.log(' Database seed completed successfully.');
  console.log('='.repeat(70));
}

// Execute CLI when directly invoked
if (process.argv[1]?.includes('seed.ts')) {
  main().catch((err) => {
    console.error('[Seed Error]:', err);
    process.exit(1);
  });
}
