import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@mandatepay/audit';
import type { DatabaseConnection } from '@mandatepay/audit';
import {
  initMerchantAndCatalogTables,
  seedStoresDatabase,
  getMerchant,
  findMerchantByDomainOrUrl,
  listMerchants,
  getCatalogItem,
  listCatalogItems,
  verifyServerItemPrice,
  DEMO_CATALOG_ITEMS,
  EVIL_CATALOG_ITEMS,
  runSeed,
} from './index.js';

describe('Merchant Registry & Deterministic Catalog (T-006, FR-13, demo.md §1)', () => {
  let db: DatabaseConnection;

  beforeEach(() => {
    db = openDb(':memory:');
    initMerchantAndCatalogTables(db);
    seedStoresDatabase(db);
  });

  describe('1. Merchant Registry (FR-13, INV-2)', () => {
    it('resolves trusted merchant and payee reference by merchant ID', () => {
      const demo = getMerchant(db, 'mrc_demo_store');
      expect(demo).not.toBeNull();
      expect(demo?.name).toBe('Demo Store (Apparel & Office Supplies)');
      expect(demo?.paypal_payee_ref).toBe('sb-merchant-demo@business.example.com');
      expect(demo?.base_url).toBe('https://demo-store.local');

      const evil = getMerchant(db, 'mrc_evil_store');
      expect(evil).not.toBeNull();
      expect(evil?.paypal_payee_ref).toBe('attacker_paypal_vault_99@evil-pay.test');
    });

    it('resolves merchant by base URL or domain string', () => {
      const byUrl = findMerchantByDomainOrUrl(db, 'https://demo-store.local');
      expect(byUrl?.id).toBe('mrc_demo_store');

      const byDomain = findMerchantByDomainOrUrl(db, 'demo-store.local');
      expect(byDomain?.id).toBe('mrc_demo_store');

      const byEvil = findMerchantByDomainOrUrl(db, 'evil-store.local');
      expect(byEvil?.id).toBe('mrc_evil_store');
    });

    it('returns null for unapproved / unknown merchant (INV-2)', () => {
      const unknown = getMerchant(db, 'mrc_rogue_unknown');
      expect(unknown).toBeNull();

      const unknownUrl = findMerchantByDomainOrUrl(db, 'unknown-store.com');
      expect(unknownUrl).toBeNull();
    });

    it('lists all registered merchants', () => {
      const merchants = listMerchants(db);
      expect(merchants).toHaveLength(2);
      expect(merchants.map((m) => m.id)).toEqual(['mrc_demo_store', 'mrc_evil_store']);
    });
  });

  describe('2. Deterministic Catalog Items & Integer Pricing (rule.md §2.2, demo.md §1)', () => {
    it('ensures all prices are strict integer minor units (USD cents)', () => {
      const allItems = [...DEMO_CATALOG_ITEMS, ...EVIL_CATALOG_ITEMS];
      for (const item of allItems) {
        expect(Number.isInteger(item.price_minor)).toBe(true);
        expect(item.price_minor).toBeGreaterThan(0);
        expect(item.currency).toBe('USD');
      }
    });

    it('matches exact catalog specs from demo.md §1', () => {
      // Pen pack: $9.00 (900 cents, office_supplies)
      const pen = getCatalogItem(db, 'mrc_demo_store', 'SKU-PEN-PACK');
      expect(pen?.price_minor).toBe(900);
      expect(pen?.category).toBe('office_supplies');

      // Notebook: $14.00 (1400 cents, office_supplies)
      const notebook = getCatalogItem(db, 'mrc_demo_store', 'SKU-NOTEBOOK');
      expect(notebook?.price_minor).toBe(1400);
      expect(notebook?.category).toBe('office_supplies');

      // Desk lamp: $45.00 (4500 cents, step-up band)
      const lamp = getCatalogItem(db, 'mrc_demo_store', 'SKU-DESK-LAMP');
      expect(lamp?.price_minor).toBe(4500);

      // Standing desk: $320.00 (32000 cents, over limit)
      const desk = getCatalogItem(db, 'mrc_demo_store', 'SKU-STAND-DESK');
      expect(desk?.price_minor).toBe(32000);

      // Book Clean Code: $38.00 (3800 cents, category books)
      const book = getCatalogItem(db, 'mrc_demo_store', 'SKU-CLEAN-CODE');
      expect(book?.price_minor).toBe(3800);
      expect(book?.category).toBe('books');

      // Evil Store: $500.00 (50000 cents, promotions) with hidden instruction payload
      const evilGift = getCatalogItem(db, 'mrc_evil_store', 'SKU-EVIL-GIFT');
      expect(evilGift?.price_minor).toBe(50000);
      expect(evilGift?.hidden_instructions).toContain('SYSTEM OVERRIDE');
    });

    it('lists catalog items with and without merchant filtering', () => {
      const demoItems = listCatalogItems(db, 'mrc_demo_store');
      expect(demoItems).toHaveLength(5);

      const evilItems = listCatalogItems(db, 'mrc_evil_store');
      expect(evilItems).toHaveLength(1);

      const all = listCatalogItems(db);
      expect(all).toHaveLength(6);
    });
  });

  describe('3. Server-side SKU Price Verification (FR-13, INV-3, P-04)', () => {
    it('verifies item price when claimed price matches server truth', () => {
      const result = verifyServerItemPrice(db, 'mrc_demo_store', 'SKU-PEN-PACK', 900, 'USD');
      expect(result.verified).toBe(true);
      expect(result.actualPriceMinor).toBe(900);
      expect(result.item?.category).toBe('office_supplies');
    });

    it('rejects price when claimed price differs from server truth (Bait-and-Switch defense, A-10)', () => {
      // Agent claims pen pack is only $1.00 (100 cents), real price is $9.00 (900 cents)
      const result = verifyServerItemPrice(db, 'mrc_demo_store', 'SKU-PEN-PACK', 100, 'USD');
      expect(result.verified).toBe(false);
      expect(result.reason).toBe('PRICE_MISMATCH');
      expect(result.actualPriceMinor).toBe(900);
    });

    it('rejects verification for nonexistent SKU or merchant', () => {
      const badSku = verifyServerItemPrice(db, 'mrc_demo_store', 'SKU-NONEXISTENT', 100);
      expect(badSku.verified).toBe(false);
      expect(badSku.reason).toBe('SKU_NOT_FOUND');

      const badMerchant = verifyServerItemPrice(db, 'mrc_fake', 'SKU-PEN-PACK', 900);
      expect(badMerchant.verified).toBe(false);
      expect(badMerchant.reason).toBe('MERCHANT_NOT_FOUND');
    });

    it('rejects currency mismatch', () => {
      const badCurrency = verifyServerItemPrice(db, 'mrc_demo_store', 'SKU-PEN-PACK', 900, 'EUR');
      expect(badCurrency.verified).toBe(false);
      expect(badCurrency.reason).toBe('CURRENCY_MISMATCH');
    });
  });

  describe('4. Deterministic Relative-Clock Database Seeder (T-006, NFR-6)', () => {
    it('seeds merchants, catalog items, and active relative-clock mandate', () => {
      const fixedNow = new Date('2026-10-20T10:00:00Z');
      const seedResult = runSeed({
        dbPath: ':memory:',
        hmacKey: 'seed_test_hmac_key_32_characters_long',
        now: fixedNow,
      });

      expect(seedResult.merchantsCount).toBe(2);
      expect(seedResult.catalogItemsCount).toBe(6);

      // Mandate assertions per demo.md §1
      const m = seedResult.mandate;
      expect(m.mandate_id).toBe('mnd_demo_001');
      expect(m.status).toBe('ACTIVE');
      expect(m.total_budget_minor).toBe(20000); // $200.00
      expect(m.per_txn_limit_minor).toBe(8000);  // $80.00
      expect(m.auto_approve_limit_minor).toBe(3000); // $30.00

      // Relative clock check (NFR-6): valid_until = valid_from + 12h
      expect(m.valid_from).toBe('2026-10-20T10:00:00.000Z');
      expect(m.valid_until).toBe('2026-10-20T22:00:00.000Z');
      expect(m.signature).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    });

    it('is idempotent when re-seeded multiple times', () => {
      const fixedNow = new Date('2026-10-20T10:00:00Z');
      const opt = {
        dbPath: ':memory:',
        hmacKey: 'seed_test_hmac_key_32_characters_long',
        now: fixedNow,
      };

      const run1 = runSeed(opt);
      const run2 = runSeed(opt);

      expect(run1.merchantsCount).toBe(run2.merchantsCount);
      expect(run1.catalogItemsCount).toBe(run2.catalogItemsCount);
      expect(run1.mandate.mandate_id).toBe(run2.mandate.mandate_id);
    });
  });
});
