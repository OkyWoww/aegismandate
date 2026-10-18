import http from 'node:http';
import playwright from 'playwright';

async function main() {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    const currentReq = requestCount;
    if (currentReq === 1) {
      setTimeout(() => {
        req.socket.destroy();
      }, 1600);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>PayPal Approval Simulation</title></head><body><h1>Approved</h1></body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(3991, resolve));
  const testUrl = 'http://127.0.0.1:3991';

  console.log('='.repeat(70));
  console.log(' PROVING PLAYWRIGHT PAGE.GOTO RETRY MECHANISM AND LOG OUTPUT');
  console.log('='.repeat(70));

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`      [Navigation Retry ${attempt}/2]: Retrying PayPal approval page navigation...`);
        }
        // Use 1500ms timeout for attempt 1 to simulate a slow sandbox network edge
        const timeoutMs = attempt === 1 ? 1500 : 5000;
        await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        break;
      } catch (err: unknown) {
        if (attempt === 2) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`      [Navigation Timeout]: ${msg || 'Gateway delayed'}, retrying navigation once...`);
        await page.waitForTimeout(500);
      }
    }

    console.log(`      Current URL: ${page.url()}`);
    console.log(`      Page title:  ${await page.title()}`);
    console.log('='.repeat(70));
    console.log(' RESULT: Successfully verified retry execution and logging.');
    console.log('='.repeat(70));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
