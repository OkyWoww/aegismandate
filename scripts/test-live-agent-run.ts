import 'dotenv/config';
import { openDb } from '../packages/audit/src/index.js';
import { PayPalClient, createMockPayPalFetch } from '../packages/paypal/src/index.js';
import { buildServer, MandateService, type StoreCatalogResolver } from '../apps/api/src/index.js';
import { seedStoresAndMandate } from '../apps/api/src/demo-seed.js';

async function main() {
  console.log('--- AegisMandate Live Agent Run Test ---');
  const apiKey = process.env['GEMINI_API_KEY'] || process.env['LLM_API_KEY'] || '';
  console.log('Gemini API Key configured:', apiKey ? `YES (prefix: ${apiKey.slice(0, 8)}..., length: ${apiKey.length})` : 'NO');
  console.log('Configured model:', process.env['LLM_MODEL'] || 'gemini-3.8-flash');

  const db = openDb(':memory:');
  const hmacKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  seedStoresAndMandate(db, hmacKey, new Date());

  const mandateService = new MandateService(db, hmacKey);
  const catalogResolver: StoreCatalogResolver = {
    getMerchantPayee(ref: string) {
      const row = db.prepare('SELECT paypal_payee_ref, name FROM merchants WHERE id = ?').get(ref) as any;
      if (!row) return null;
      return { payeeRef: row.paypal_payee_ref, merchantId: ref, name: row.name };
    },
    getItem(merchantRef: string, sku: string) {
      const row = db.prepare('SELECT price_minor, name, category FROM catalog_items WHERE merchant_id = ? AND sku = ?').get(merchantRef, sku) as any;
      if (!row) return null;
      return { verified: true, priceMinor: row.price_minor, name: row.name, category: row.category };
    },
  };

  const payPalClient = new PayPalClient({
    clientId: 'mock_client_id',
    clientSecret: 'mock_client_secret',
    environment: 'sandbox',
    fetchFn: createMockPayPalFetch(),
  });

  const server = await buildServer({
    db,
    mandateService,
    catalogResolver,
    payPalClient,
    hmacKey,
    ownerToken: 'test_owner_secret_token_at_least_32_chars_long!',
  });

  console.log('\nSending POST /v1/agent/run with prompt: "Find a gel pen pack for my desk and purchase one pack."');
  const start = Date.now();
  const res = await server.inject({
    method: 'POST',
    url: '/v1/agent/run',
    payload: {
      prompt: 'Find a gel pen pack for my desk and purchase one pack.',
      mandate_id: 'mnd_demo_001',
      mode: 'defensive',
    },
  });

  console.log(`\nResponse received in ${Date.now() - start}ms: Status ${res.statusCode}`);
  const json = JSON.parse(res.body);
  console.log(JSON.stringify(json, null, 2));

  await server.close();
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
