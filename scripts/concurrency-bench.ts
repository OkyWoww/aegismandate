/**
 * Standalone SQLite Multi-Process Concurrency Benchmark (Priority 2)
 *
 * Spawns 4 independent OS worker processes simultaneously executing
 * 50 write transactions each (total >=200 events) against the same WAL SQLite database
 * using BEGIN IMMEDIATE transactions and exponential backoff retry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb, initAuditTable, getAuditEvents, verifyAuditLedger } from '../packages/audit/src/index.js';

async function runConcurrencyBenchmark() {
  const benchDir = path.resolve('data');
  const benchDbPath = path.join(benchDir, 'concurrency-bench.db');
  const workerScriptPath = path.resolve('scripts/concurrency-worker.ts');
  const tsxCliPath = path.resolve('node_modules/tsx/dist/cli.mjs');

  const workerCount = 4;
  const txPerWorker = 50;
  const totalExpectedEvents = workerCount * txPerWorker; // 200 events

  console.log('='.repeat(80));
  console.log(' SQLITE MULTI-PROCESS WAL CONCURRENCY BENCHMARK (BEGIN IMMEDIATE)');
  console.log(' Target Database : ' + benchDbPath);
  console.log(` Concurrency     : ${workerCount} OS processes × ${txPerWorker} transactions = ${totalExpectedEvents} total events`);
  console.log('='.repeat(80));

  // Clean previous run
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const f = benchDbPath + ext;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  }

  // Initialize DB table in WAL mode
  const initDb = openDb(benchDbPath);
  initAuditTable(initDb);
  initDb.close();

  const startTime = Date.now();

  // Spawn 4 independent OS processes
  console.log(`\nLaunching ${workerCount} concurrent child processes...`);
  const workerPromises = Array.from({ length: workerCount }, (_, workerId) => {
    return new Promise<{ workerId: number; durationMs: number }>((resolve, reject) => {
      const wStart = Date.now();
      const child = spawn(
        process.execPath,
        [tsxCliPath, workerScriptPath, benchDbPath, String(workerId), String(txPerWorker)],
        { stdio: 'inherit' },
      );

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ workerId, durationMs: Date.now() - wStart });
        } else {
          reject(new Error(`Worker process ${workerId} failed with exit code ${code}`));
        }
      });

      child.on('error', reject);
    });
  });

  const workerResults = await Promise.all(workerPromises);
  const totalElapsedMs = Date.now() - startTime;

  console.log('\nAll worker processes completed successfully:');
  for (const wr of workerResults) {
    console.log(`  -> Worker ${wr.workerId}: 50 transactions in ${wr.durationMs}ms (${(50 / (wr.durationMs / 1000)).toFixed(1)} tx/s)`);
  }

  // Verification
  console.log('\nVerifying database consistency and cryptographic integrity...');
  const verifyDb = openDb(benchDbPath);
  const events = getAuditEvents(verifyDb, { limit: 500 });

  // 1. Event count check
  if (events.length !== totalExpectedEvents) {
    throw new Error(`Expected ${totalExpectedEvents} events, found ${events.length}`);
  }

  // 2. Strict contiguous sequence numbering check (1..200 with zero gaps or duplicates)
  const seqSet = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    seqSet.add(ev.seq);
  }

  if (seqSet.size !== totalExpectedEvents) {
    throw new Error(`Sequence collision detected! Unique seqs: ${seqSet.size}/${totalExpectedEvents}`);
  }

  for (let s = 1; s <= totalExpectedEvents; s++) {
    if (!seqSet.has(s)) {
      throw new Error(`Sequence gap detected! Missing seq #${s}`);
    }
  }

  // 3. Cryptographic hash chain verification
  const chainResult = verifyAuditLedger(verifyDb);
  if (!chainResult.valid) {
    throw new Error(`Cryptographic audit chain broken at seq #${chainResult.brokenAtSeq}: ${chainResult.reason}`);
  }

  verifyDb.close();

  // Print results summary
  const throughput = (totalExpectedEvents / (totalElapsedMs / 1000)).toFixed(1);
  console.log('\n' + '='.repeat(80));
  console.log(' BENCHMARK RESULTS SUMMARY (100% PASS)');
  console.log('='.repeat(80));
  console.log(`Total Events Committed      : ${events.length} / ${totalExpectedEvents}`);
  console.log(`Total Elapsed Time          : ${totalElapsedMs}ms`);
  console.log(`Effective Contention Rate   : ${throughput} transactions/sec`);
  console.log(`Unhandled SQLITE_BUSY Errors: 0 (Zero lock contention drops)`);
  console.log(`Sequence Continuity Check   : 100% Contiguous (1..${totalExpectedEvents}, zero gaps, zero forks)`);
  console.log(`SHA-256 Hash Chain Integrity: VALID (Unbroken cryptographic chain)`);
  console.log('='.repeat(80));
}

runConcurrencyBenchmark().catch((err) => {
  console.error('\nBenchmark failed:', err);
  process.exit(1);
});
