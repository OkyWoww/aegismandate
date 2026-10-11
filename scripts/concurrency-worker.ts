import { openDb, appendAuditEvent } from '../packages/audit/src/index.js';

async function main() {
  const dbPath = process.argv[2];
  const workerId = Number(process.argv[3]);
  const eventCount = Number(process.argv[4]);

  if (!dbPath || isNaN(workerId) || isNaN(eventCount)) {
    console.error('Usage: tsx concurrency-worker.ts <dbPath> <workerId> <eventCount>');
    process.exit(1);
  }

  const db = openDb(dbPath);

  for (let i = 0; i < eventCount; i++) {
    // Add micro jitter to simulate real concurrent traffic
    if (i % 5 === 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
    }
    appendAuditEvent(db, {
      actor: 'control_plane',
      type: 'CONCURRENCY_BURST',
      ref: `worker_${workerId}_tx_${i}`,
      payload: { workerId, txId: i, ts: Date.now() },
    });
  }

  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
