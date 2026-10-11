import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AuditEvent } from '@mandatepay/schemas';
import fs from 'node:fs';
import path from 'node:path';
import {
  openDb,
  canonicalJson,
  computeEventHash,
  appendAuditEvent,
  getAuditEvents,
  verifyAuditLedger,
  initAuditTable,
  GENESIS_HASH,
  type DatabaseConnection,
} from './index.js';

describe('Audit Ledger Package (packages/audit) — FR-21, FR-22, AC-5, AC-11', () => {
  const testDbDir = path.resolve(__dirname, '../../../data/test-audit');
  const testDbPath = path.join(testDbDir, 'test-audit.db');
  let db: DatabaseConnection;

  beforeEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDbDir, { recursive: true });
    db = openDb(testDbPath);
    initAuditTable(db);
  });

  afterEach(() => {
    try {
      if (db.isOpen()) {
        db.close();
      }
    } catch {
      // Ignore
    }
    if (fs.existsSync(testDbDir)) {
      try {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      } catch {
        // Ignore file lock on Windows cleanup
      }
    }
  });

  // ============================================================================
  // 1. CANONICAL JSON DETERMINISM
  // ============================================================================
  describe('Canonical JSON serialization', () => {
    it('produces identical strings regardless of object key insertion order', () => {
      const objA = { b: 2, a: 1, c: { z: 26, y: 25 } };
      const objB = { c: { y: 25, z: 26 }, a: 1, b: 2 };

      expect(canonicalJson(objA)).toBe(canonicalJson(objB));
      expect(canonicalJson(objA)).toBe('{"a":1,"b":2,"c":{"y":25,"z":26}}');
    });

    it('correctly handles primitives, arrays, and nulls', () => {
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson(42)).toBe('42');
      expect(canonicalJson('hello')).toBe('"hello"');
      expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    });

    it('computeEventHash produces deterministic SHA-256 hash', () => {
      const h1 = computeEventHash(GENESIS_HASH, {
        seq: 1,
        ts: '2026-10-11T00:00:00Z',
        actor: 'user',
        type: 'MANDATE_CREATED',
        ref: 'mnd_1',
        payload: { b: 2, a: 1 },
      });
      const h2 = computeEventHash(GENESIS_HASH, {
        seq: 1,
        ts: '2026-10-11T00:00:00Z',
        actor: 'user',
        type: 'MANDATE_CREATED',
        ref: 'mnd_1',
        payload: { a: 1, b: 2 },
      });
      expect(h1).toHaveLength(64);
      expect(h1).toBe(h2);
    });
  });

  // ============================================================================
  // 2. POSITIVE SEQUENTIAL APPEND & CHAIN INTEGRITY
  // ============================================================================
  describe('Sequential event appending & verification', () => {
    it('initializes with empty ledger returning valid', () => {
      const res = verifyAuditLedger(db);
      expect(res.valid).toBe(true);
      expect(res.count).toBe(0);
    });

    it('appends events with genesis linkage and valid sequential hashes', () => {
      const e1 = appendAuditEvent(db, {
        actor: 'user',
        type: 'MANDATE_CREATED',
        ref: 'mnd_001',
        payload: { limit: 10000, currency: 'USD' },
      });

      expect(e1.seq).toBe(1);
      expect(e1.prev_hash).toBe(GENESIS_HASH);
      expect(e1.hash).toHaveLength(64);

      const e2 = appendAuditEvent(db, {
        actor: 'agent',
        type: 'INTENT_SUBMITTED',
        ref: 'int_001',
        payload: { total: 2500, merchant: 'mrc_store' },
      });

      expect(e2.seq).toBe(2);
      expect(e2.prev_hash).toBe(e1.hash);

      const e3 = appendAuditEvent(db, {
        actor: 'control_plane',
        type: 'INTENT_DECIDED',
        ref: 'int_001',
        payload: { verdict: 'ALLOW' },
      });

      expect(e3.seq).toBe(3);
      expect(e3.prev_hash).toBe(e2.hash);

      const events = getAuditEvents(db);
      expect(events).toHaveLength(3);

      const verification = verifyAuditLedger(db);
      expect(verification.valid).toBe(true);
      expect(verification.count).toBe(3);
    });
  });

  // ============================================================================
  // 3. TAMPER DETECTION TESTS (AC-5, FR-22)
  // ============================================================================
  describe('Tamper detection (AC-5)', () => {
    it('detects when an intermediate payload is altered and pinpoints the exact seq', () => {
      // Append 5 events
      for (let i = 1; i <= 5; i++) {
        appendAuditEvent(db, {
          actor: 'control_plane',
          type: 'TEST_EVENT',
          ref: `ref_${i}`,
          payload: { step: i, amount: i * 100 },
        });
      }

      const initialVerify = verifyAuditLedger(db);
      expect(initialVerify.valid).toBe(true);
      expect(initialVerify.count).toBe(5);

      // Manually tamper with row 3's payload directly in SQLite
      db.prepare(`
        UPDATE audit_events
        SET payload = json('{"step":3,"amount":999999,"tampered":true}')
        WHERE seq = 3
      `).run();

      const tamperedVerify = verifyAuditLedger(db);
      expect(tamperedVerify.valid).toBe(false);
      expect(tamperedVerify.brokenAtSeq).toBe(3);
      expect(tamperedVerify.reason).toBe('HASH_TAMPERED');
    });

    it('detects when an intermediate hash is forged and pinpoints downstream prev_hash mismatch', () => {
      for (let i = 1; i <= 4; i++) {
        appendAuditEvent(db, {
          actor: 'user',
          type: 'EVENT',
          ref: `ref_${i}`,
          payload: { i },
        });
      }

      // Re-hash row 2 with an altered hash, without updating row 3's prev_hash
      db.prepare(`
        UPDATE audit_events
        SET hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        WHERE seq = 2
      `).run();

      const verifyRes = verifyAuditLedger(db);
      expect(verifyRes.valid).toBe(false);
      // Row 2 itself fails hash recomputation first
      expect(verifyRes.brokenAtSeq).toBe(2);
      expect(verifyRes.reason).toBe('HASH_TAMPERED');
    });

    it('detects a broken prev_hash link between consecutive rows', () => {
      appendAuditEvent(db, { actor: 'user', type: 'E1', ref: 'r1', payload: {} });
      appendAuditEvent(db, { actor: 'user', type: 'E2', ref: 'r2', payload: {} });

      // Intentionally break prev_hash of row 2
      db.prepare(`
        UPDATE audit_events
        SET prev_hash = '1111111111111111111111111111111111111111111111111111111111111111'
        WHERE seq = 2
      `).run();

      const res = verifyAuditLedger(db);
      expect(res.valid).toBe(false);
      expect(res.brokenAtSeq).toBe(2);
      expect(res.reason).toBe('PREV_HASH_MISMATCH');
    });
  });

  // ============================================================================
  // 4. CONCURRENCY BURST TEST (AC-11 — ≥ 200 events across multiple connections)
  // ============================================================================
  describe('Concurrency burst (AC-11)', () => {
    it('processes ≥ 200 events across multiple connections without forks or SQLITE_BUSY', () => {
      const connCount = 4;
      const eventsPerConn = 50;
      const totalEvents = connCount * eventsPerConn; // 200 events

      // Create multiple distinct database connections to the same file
      const connections: DatabaseConnection[] = [];
      for (let c = 0; c < connCount; c++) {
        connections.push(openDb(testDbPath));
      }

      // Execute interleaved inserts simulating concurrent worker processes
      for (let round = 0; round < eventsPerConn; round++) {
        for (let c = 0; c < connCount; c++) {
          const workerDb = connections[c]!;
          const evt = appendAuditEvent(workerDb, {
            actor: c % 2 === 0 ? 'agent' : 'control_plane',
            type: 'BURST_TXN',
            ref: `worker_${c}_round_${round}`,
            payload: { workerId: c, round, amountMinor: 100 + round },
          });
          expect(evt.seq).toBeGreaterThan(0);
        }
      }

      // Close extra connections
      for (const conn of connections) {
        conn.close();
      }

      // Re-open inspection connection and verify
      const verifyDb = openDb(testDbPath);
      const rows = getAuditEvents(verifyDb, { limit: 300 });

      expect(rows).toHaveLength(totalEvents);

      // Verify sequence is strictly contiguous 1..200 with zero gaps or duplicates
      for (let i = 0; i < totalEvents; i++) {
        expect(rows[i]?.seq).toBe(i + 1);
      }

      // Verify cryptographic chain across all 200 events
      const chainVerification = verifyAuditLedger(verifyDb);
      expect(chainVerification.valid).toBe(true);
      expect(chainVerification.count).toBe(totalEvents);
      expect(chainVerification.brokenAtSeq).toBeUndefined();

      verifyDb.close();
    });

    it('processes true asynchronous parallel concurrency burst (≥ 200 events) across 5 separate connections using Promise.all under real contention', async () => {
      const concurrencyDbPath = path.join(testDbDir, 'concurrency_race.db');
      const connCount = 5;
      const eventsPerConn = 40;
      const totalEvents = connCount * eventsPerConn; // 200 events

      const connections: DatabaseConnection[] = [];
      for (let c = 0; c < connCount; c++) {
        connections.push(openDb(concurrencyDbPath));
      }

      // Launch 200 concurrent promises across 5 distinct connections with random micro-delays
      const tasks: Array<() => Promise<AuditEvent>> = [];
      for (let c = 0; c < connCount; c++) {
        for (let i = 0; i < eventsPerConn; i++) {
          const workerConn = connections[c]!;
          const workerId = c;
          const taskId = i;
          tasks.push(async () => {
            // Yield to event loop to induce real SQLite lock contention
            await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
            return appendAuditEvent(workerConn, {
              actor: 'control_plane',
              type: 'RACE_BURST',
              ref: `worker_${workerId}_task_${taskId}`,
              payload: { workerId, taskId, ts: Date.now() },
            });
          });
        }
      }

      // Execute all 200 writes concurrently
      const appended = await Promise.all(tasks.map((t) => t()));
      expect(appended).toHaveLength(totalEvents);

      for (const conn of connections) {
        conn.close();
      }

      // Verify final ledger with fresh connection
      const verifyDb = openDb(concurrencyDbPath);
      const rows = getAuditEvents(verifyDb, { limit: 300 });
      expect(rows).toHaveLength(totalEvents);

      // Verify unbroken sequence 1..200 with zero duplicates or gaps
      const seqSet = new Set<number>();
      for (const r of rows) {
        seqSet.add(r.seq);
      }
      expect(seqSet.size).toBe(totalEvents);
      for (let s = 1; s <= totalEvents; s++) {
        expect(seqSet.has(s)).toBe(true);
      }

      const chainVerification = verifyAuditLedger(verifyDb);
      expect(chainVerification.valid).toBe(true);
      expect(chainVerification.count).toBe(totalEvents);
      expect(chainVerification.brokenAtSeq).toBeUndefined();

      verifyDb.close();
    });
  });
});
