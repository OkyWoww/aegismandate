import 'dotenv/config';
import { PayPalClient } from '../packages/paypal/src/index.js';

async function run() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in .env');
    process.exit(1);
  }

  const client = new PayPalClient({
    clientId,
    clientSecret,
    environment: 'sandbox',
  });

  console.log('='.repeat(70));
  console.log('CREATE REAL ORDER KE PAYPAL SANDBOX (POST /v2/checkout/orders)');
  console.log('Target API: https://api-m.sandbox.paypal.com');
  console.log('='.repeat(70));

  const t0 = Date.now();
  await client.getAccessToken();
  console.log(`OAuth 2.0 Token acquired: [REDACTED] (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  const order = await client.createOrder({
    referenceId: `mandate_live_${Date.now()}`,
    currency: 'USD',
    totalMinor: 1500, // $15.00 USD
    items: [
      {
        name: 'Aegis Security License Pack',
        sku: 'SKU-AEGIS-SEC',
        quantity: 1,
        unitAmountMinor: 1500,
      },
    ],
    returnUrl: 'https://example.com/checkout/success',
    cancelUrl: 'https://example.com/checkout/cancel',
  });
  const elapsed = Date.now() - t1;

  const approveLink = order.links?.find(
    (l) => l.rel === 'approve' || l.rel === 'payer-action',
  )?.href;

  console.log('\n--- HASIL PEMBUATAN ORDER NYATA ---');
  console.log(`Order ID (17 Karakter) : ${order.id}`);
  console.log(`Panjang Order ID        : ${order.id.length} karakter`);
  console.log(`Status Order Saat Ini   : ${order.status}`);
  console.log(`Latency Jaringan API    : ${elapsed}ms`);
  console.log('\n--- LINK APPROVE (PAYER-ACTION) ---');
  console.log(`Approve URL             : ${approveLink}`);
  console.log('='.repeat(70));
  console.log('Petunjuk untuk Payer:');
  console.log('Buka URL Approve di browser sandbox, login akun buyer PayPal, dan konfirmasi pembayaran.');
  console.log(`Setelah disetujui, order dapat di-capture via:`);
  console.log(`npx tsx scripts/paypal-capture-proof.ts --order=${order.id}`);
  console.log('='.repeat(70));
}

run().catch((err) => {
  console.error('Error saat membuat order ke PayPal:', err);
  process.exit(1);
});
