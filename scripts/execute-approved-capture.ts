import 'dotenv/config';
import { PayPalClient } from '../packages/paypal/src/index.js';

async function main() {
  const orderId = process.argv[2] || '0VJ350000M292973P';
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

  console.log('='.repeat(80));
  console.log(`PAYPAL SANDBOX LIVE CAPTURE EXECUTION FOR APPROVED ORDER`);
  console.log(`Target Endpoint: https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`);
  console.log('='.repeat(80));

  // 1. OAuth
  const t0 = Date.now();
  const token = await client.getAccessToken();
  const dOAuth = Date.now() - t0;
  console.log(`[1] OAuth Bearer Token acquired in ${dOAuth}ms: [REDACTED] (${token.length} chars)`);

  // 2. Check Order Status Before Capture
  console.log(`\n[2] Verifying Live Order State via GET /v2/checkout/orders/${orderId}...`);
  const tGet = Date.now();
  const orderBefore = await client.getOrder(orderId);
  const dGet = Date.now() - tGet;
  console.log(`    Status:   ${orderBefore.status}`);
  console.log(`    Latency:  ${dGet}ms`);
  console.log(`    Order Details:`, JSON.stringify(orderBefore, null, 2));

  // 3. Execute Capture
  console.log(`\n[3] Executing Live Capture via POST /v2/checkout/orders/${orderId}/capture...`);
  const tCap = Date.now();
  const requestId = `cap_req_${Date.now()}`;

  const captureRes = await client.captureOrder(orderId, requestId);
  const dCap = Date.now() - tCap;

  console.log(`\n================================================================================`);
  console.log(` LIVE PAYPAL CAPTURE SUCCESSFUL!`);
  console.log(`================================================================================`);
  console.log(`Order ID                  : ${orderId}`);
  console.log(`Capture Latency           : ${dCap}ms`);
  console.log(`Root Response ID          : ${captureRes.id}`);
  console.log(`Overall Status            : ${captureRes.status}`);

  // Extract specific capture details from purchase_units
  const captures = captureRes.purchase_units?.[0]?.payments?.captures;
  const primaryCapture = captures?.[0];
  const captureId = primaryCapture?.id || captureRes.id;
  const captureAmount = primaryCapture?.amount || captureRes.amount;

  console.log(`Primary Capture ID (17 Chars): ${captureId} (Length: ${captureId.length} characters)`);
  console.log(`Captured Amount           : ${captureAmount?.currency_code || 'USD'} ${captureAmount?.value || 'N/A'}`);
  console.log(`Seller Protection Status  : ${primaryCapture?.seller_protection?.status || captureRes.seller_protection?.status || 'N/A'}`);

  console.log(`\n--- FULL PAYPAL API RESPONSE ---`);
  console.log(JSON.stringify(captureRes, null, 2));
  console.log('='.repeat(80));
}

main().catch((err) => {
  console.error('\nCapture execution error:', err);
  process.exit(1);
});
