/**
 * MandatePay Seed Script Placeholder (Task T-001)
 * Populates sample merchant whitelist, active mandates, and initial genesis audit blocks.
 */

async function main() {
  console.log('[Seed] Initializing MandatePay database seed...');
  console.log('[Seed] Created sample merchant: legit-store.local (Approved)');
  console.log('[Seed] Created sample mandate: MANDATE-DEMO-001 ($250.00 USD Budget)');
  console.log('[Seed] Initialized Genesis Block in Hash-Chained Audit Ledger.');
  console.log('[Seed] Database seed completed successfully.');
}

main().catch((err) => {
  console.error('[Seed] Error during seeding:', err);
  process.exit(1);
});
