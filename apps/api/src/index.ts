import { evaluatePolicy } from '@mandatepay/policy';
import { verifyLedgerIntegrity } from '@mandatepay/audit';
import { scanAdvisoryText } from '@mandatepay/scanner';
import { PayPalClient } from '@mandatepay/paypal';
import type { Mandate, PurchaseIntent, PolicyDecision } from '@mandatepay/schemas';

export interface ControlPlaneService {
  evaluateIntent: (mandate: Mandate, intent: PurchaseIntent, currentSpend: number, now?: string) => PolicyDecision;
  scanPayload: (text: string) => ReturnType<typeof scanAdvisoryText>;
  verifyLedger: (events: Parameters<typeof verifyLedgerIntegrity>[0]) => ReturnType<typeof verifyLedgerIntegrity>;
  paypalClient: PayPalClient;
}

export function createControlPlane(payPalConfig: ConstructorParameters<typeof PayPalClient>[0]): ControlPlaneService {
  return {
    evaluateIntent: (mandate, intent, currentSpend, now) =>
      evaluatePolicy({
        mandate,
        intent,
        cumulativeSpendToDate: currentSpend,
        evaluatedAt: now ?? mandate.valid_from,
      }),
    scanPayload: (text) => scanAdvisoryText(text),
    verifyLedger: (events) => verifyLedgerIntegrity(events),
    paypalClient: new PayPalClient(payPalConfig),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { openDb } from '@mandatepay/audit';
import { initMandateTables, MandateService } from './mandate-service.js';
import {
  initExecutorTables,
  type StoreCatalogResolver,
  sweepExpiredIntents,
  reconcileCapturingIntents,
} from './executor.js';
import { buildServer } from './server.js';
import { initMerchantAndCatalogSchema, seedStoresAndMandate } from './demo-seed.js';

export * from './mandate-service.js';
export * from './executor.js';
export * from './server.js';

export interface StartServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  dbPath?: string | undefined;
  hmacKey?: string | undefined;
  logger?: boolean | undefined;
}

/**
 * Boots the Fastify HTTP Control Plane server with database and PayPal dependencies.
 */
export async function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? (Number(process.env['PORT']) || 8787);
  const host = options.host ?? (process.env['HOST'] || '0.0.0.0');
  const dbPath = options.dbPath ?? (process.env['DB_PATH'] || './data/mandatepay.db');
  const hmacKey = options.hmacKey ?? (process.env['MANDATE_HMAC_KEY'] || 'default_mandate_hmac_secret_key_32chars!');

  const dir = path.dirname(dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = openDb(dbPath);
  initMandateTables(db);
  initExecutorTables(db);
  initMerchantAndCatalogSchema(db);

  // Auto-seed if database is fresh (merchants or demo mandate missing)
  const existingMerchant = db.prepare('SELECT id FROM merchants LIMIT 1').get();
  const existingMandate = db.prepare("SELECT id FROM mandates WHERE id = 'mnd_demo_001'").get();
  if (!existingMerchant || !existingMandate) {
    console.log('[Seed] Fresh database detected. Seeding demo merchants, catalog, and mnd_demo_001...');
    seedStoresAndMandate(db, hmacKey, new Date());
    console.log('[Seed] Demo data seeded successfully.');
  }

  const catalogResolver: StoreCatalogResolver = {
    getMerchantPayee: (ref: string) => {
      const row = db
        .prepare('SELECT id, name, paypal_payee_ref FROM merchants WHERE id = ?')
        .get(ref) as { id: string; name: string; paypal_payee_ref: string } | undefined;
      return row ? { merchantId: row.id, name: row.name, payeeRef: row.paypal_payee_ref } : null;
    },
    getItem: (merchantRef: string, sku: string) => {
      const row = db
        .prepare('SELECT price_minor, name, category FROM catalog_items WHERE merchant_id = ? AND sku = ?')
        .get(merchantRef, sku) as { price_minor: number; name: string; category: string } | undefined;
      return row ? { verified: true, priceMinor: row.price_minor, name: row.name, category: row.category } : null;
    },
  };

  const mandateService = new MandateService(db, hmacKey);
  const payPalClient = new PayPalClient({
    clientId: process.env['PAYPAL_CLIENT_ID'] || 'sandbox_client_id_dev',
    clientSecret: process.env['PAYPAL_CLIENT_SECRET'] || 'sandbox_client_secret_dev',
    environment: 'sandbox',
  });

  const app = await buildServer({
    db,
    mandateService,
    catalogResolver,
    payPalClient,
    hmacKey,
    ownerToken: process.env['OWNER_TOKEN'],
    agentToken: process.env['AGENT_TOKEN'],
    webhookId: process.env['PAYPAL_WEBHOOK_ID'],
    logger: options.logger ?? false,
  });

  app.addHook('onClose', async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  // Reconcile in-flight capturing intents on startup (FR-37) and sweep expired unapproved intents (FR-34)
  try {
    sweepExpiredIntents(db, mandateService);
    await reconcileCapturingIntents({ db, payPalClient, mandateService, catalogResolver });
  } catch (err) {
    console.warn('[Startup Reconciliation Warning]:', err);
  }

  await app.listen({ port, host });
  console.log(`[Control Plane API] Listening at http://${host}:${port}`);
  return { app, db, port, host };
}

// Auto-boot if executed directly via CLI
if (process.argv[1]?.includes('index.ts') || process.argv[1]?.includes('index.js')) {
  startServer({ logger: true }).catch((err) => {
    console.error('[API Startup Error]:', err);
    process.exit(1);
  });
}

