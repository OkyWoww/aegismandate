import { openDb } from '@mandatepay/audit';
import { MandateService, initMandateTables } from '@mandatepay/api';
import {
  initMerchantAndCatalogTables,
  seedStoresDatabase,
} from './index.js';

export interface SeedOptions {
  dbPath?: string;
  hmacKey?: string;
  now?: Date;
}

export interface SeedResult {
  dbPath: string;
  merchantsCount: number;
  catalogItemsCount: number;
  mandate: {
    mandate_id: string;
    owner_id: string;
    agent_id: string;
    status: string;
    total_budget_minor: number;
    per_txn_limit_minor: number;
    auto_approve_limit_minor: number;
    valid_from: string;
    valid_until: string;
    signature: string;
  };
}

/**
 * Deterministic database seed runner (T-006, demo.md §1, NFR-6).
 * Populates merchants, catalog items, and active relative-clock demo mandate.
 */
export function runSeed(options: SeedOptions = {}): SeedResult {
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? './data/mandatepay.db';
  const hmacKey =
    options.hmacKey ??
    process.env.MANDATE_HMAC_KEY ??
    'mandatepay_demo_hmac_secret_key_default_32chars_for_local_testing';

  const now = options.now ?? new Date();
  const validFrom = now.toISOString();
  // Relative clock: exactly 12 hours from execution time (demo.md §1, NFR-6)
  const validUntil = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();

  const db = openDb(dbPath);

  // 1. Initialize tables
  initMerchantAndCatalogTables(db);
  initMandateTables(db);

  // 2. Seed Merchants & Catalog items
  const storeCounts = seedStoresDatabase(db);

  // 3. Seed Demo Mandate (mnd_demo_001) per demo.md §1
  const mandateService = new MandateService(db, hmacKey, () => validFrom);

  const existingMandate = db
    .prepare('SELECT id FROM mandates WHERE id = ?')
    .get('mnd_demo_001');

  if (existingMandate) {
    // Clean reset for idempotent re-seeding
    db.prepare('DELETE FROM reservations WHERE mandate_id = ?').run('mnd_demo_001');
    db.prepare('DELETE FROM mandate_spend WHERE mandate_id = ?').run('mnd_demo_001');
    db.prepare('DELETE FROM mandates WHERE id = ?').run('mnd_demo_001');
  }

  // Create and activate mandate with relative-clock TTL (NFR-6)
  mandateService.createDraft({
    mandate_id: 'mnd_demo_001',
    owner_id: 'usr_demo',
    agent_id: 'agt_shopper_1',
    currency: 'USD',
    valid_from: validFrom,
    valid_until: validUntil,
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
    wallet: { type: 'paypal_vault', ref: 'pt_sandbox_shopper_vault_ref' },
    created_at: validFrom,
  });

  const activeMandate = mandateService.activate('mnd_demo_001');

  return {
    dbPath,
    merchantsCount: storeCounts.merchantsCount,
    catalogItemsCount: storeCounts.catalogItemsCount,
    mandate: {
      mandate_id: activeMandate.mandate_id,
      owner_id: activeMandate.owner_id,
      agent_id: activeMandate.agent_id,
      status: activeMandate.status,
      total_budget_minor: activeMandate.total_budget_minor,
      per_txn_limit_minor: activeMandate.per_txn_limit_minor,
      auto_approve_limit_minor: activeMandate.auto_approve_limit_minor,
      valid_from: activeMandate.valid_from,
      valid_until: activeMandate.valid_until,
      signature: activeMandate.signature,
    },
  };
}
