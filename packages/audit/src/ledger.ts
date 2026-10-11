import { createHash } from 'node:crypto';
import type { AuditEvent, AuditActor } from '@mandatepay/schemas';
import { canonicalJson } from './canonical.js';
import type { DatabaseConnection } from './db.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface AppendEventParams {
  actor: AuditActor;
  type: string;
  ref: string;
  payload: Record<string, unknown>;
  ts?: string;
}

export interface VerifyResult {
  valid: boolean;
  brokenAtSeq?: number;
  reason?: 'SEQUENCE_GAP_OR_FORK' | 'PREV_HASH_MISMATCH' | 'HASH_TAMPERED' | 'INVALID_ROW';
  count: number;
}

/**
 * Initializes the audit ledger SQLite schema if not already present.
 * Uses UNIQUE(prev_hash) and PRIMARY KEY(seq) to prevent forks and ensure sequential ordering (design.md §8).
 */
export function initAuditTable(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      seq INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      ref TEXT NOT NULL,
      payload TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      CONSTRAINT uq_audit_prev_hash UNIQUE (prev_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ref ON audit_events(ref);
    CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(type);
  `);
}

/**
 * Computes sha256 hash chaining prev_hash + canonical JSON representation
 * per spec.md §3.5:
 * hash = sha256(prev_hash || canonical_json(seq,ts,actor,type,ref,payload))
 */
export function computeEventHash(
  prevHash: string,
  event: {
    seq: number;
    ts: string;
    actor: string;
    type: string;
    ref: string;
    payload: Record<string, unknown>;
  },
): string {
  const canonicalData = canonicalJson({
    seq: event.seq,
    ts: event.ts,
    actor: event.actor,
    type: event.type,
    ref: event.ref,
    payload: event.payload,
  });
  return createHash('sha256')
    .update(`${prevHash}||${canonicalData}`)
    .digest('hex');
}

/**
 * Appends an audit event to the hash chain using BEGIN IMMEDIATE.
 * Guarantees serial execution and fork-free contiguous seq numbers under concurrency.
 * Includes backstop retry handling for competing writes.
 */
export function appendAuditEvent(
  db: DatabaseConnection,
  params: AppendEventParams,
  maxRetries = 10,
): AuditEvent {
  initAuditTable(db);

  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      db.exec('BEGIN IMMEDIATE');

      const lastRow = db
        .prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1')
        .get() as { seq: number; hash: string } | undefined;

      const seq = lastRow ? Number(lastRow.seq) + 1 : 1;
      const prev_hash = lastRow ? String(lastRow.hash) : GENESIS_HASH;
      const ts = params.ts ?? new Date().toISOString();

      const hash = computeEventHash(prev_hash, {
        seq,
        ts,
        actor: params.actor,
        type: params.type,
        ref: params.ref,
        payload: params.payload,
      });

      const serializedPayload = canonicalJson(params.payload);

      db.prepare(`
        INSERT INTO audit_events (seq, ts, actor, type, ref, payload, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(seq, ts, params.actor, params.type, params.ref, serializedPayload, prev_hash, hash);

      db.exec('COMMIT');

      return {
        seq,
        ts,
        actor: params.actor,
        type: params.type,
        ref: params.ref,
        payload: params.payload,
        prev_hash,
        hash,
      };
    } catch (err: unknown) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Rollback error ignored if already rolled back
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('busy') || errMsg.includes('locked')) {
        attempt++;
        // Small exponential-ish synchronous jitter before retry
        const sleepMs = 5 * attempt + Math.floor(Math.random() * 10);
        const start = Date.now();
        while (Date.now() - start < sleepMs) {
          // sync spin wait
        }
        continue;
      }

      throw err;
    }
  }

  throw new Error(`Failed to append audit event after ${maxRetries} retries due to database busy`);
}

/**
 * Retrieves audit events with optional pagination and filters.
 */
export function getAuditEvents(
  db: DatabaseConnection,
  options?: { limit?: number; offset?: number; ref?: string; type?: string },
): AuditEvent[] {
  initAuditTable(db);

  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  let query = 'SELECT seq, ts, actor, type, ref, payload, prev_hash, hash FROM audit_events';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.ref) {
    conditions.push('ref = ?');
    params.push(options.ref);
  }
  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ' ORDER BY seq ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params) as Array<{
    seq: number;
    ts: string;
    actor: AuditActor;
    type: string;
    ref: string;
    payload: string;
    prev_hash: string;
    hash: string;
  }>;

  return rows.map((r) => ({
    seq: Number(r.seq),
    ts: r.ts,
    actor: r.actor,
    type: r.type,
    ref: r.ref,
    payload: JSON.parse(r.payload),
    prev_hash: r.prev_hash,
    hash: r.hash,
  }));
}

function isDbConnection(s: DatabaseConnection | readonly AuditEvent[]): s is DatabaseConnection {
  return typeof (s as DatabaseConnection).prepare === 'function';
}

/**
 * Validates the cryptographic chain integrity of the ledger per FR-22, AC-5, and AC-11.
 * Streams rows, checks linkage from genesis, recalculates SHA-256 hashes,
 * and reports the exact sequence number if tampered.
 */
export function verifyAuditLedger(
  source: DatabaseConnection | readonly AuditEvent[],
): VerifyResult {
  let events: AuditEvent[];

  if (isDbConnection(source)) {
    initAuditTable(source);
    const rows = source
      .prepare('SELECT seq, ts, actor, type, ref, payload, prev_hash, hash FROM audit_events ORDER BY seq ASC')
      .all() as Array<{
        seq: number;
        ts: string;
        actor: AuditActor;
        type: string;
        ref: string;
        payload: string;
        prev_hash: string;
        hash: string;
      }>;

    events = rows.map((r) => ({
      seq: Number(r.seq),
      ts: r.ts,
      actor: r.actor,
      type: r.type,
      ref: r.ref,
      payload: JSON.parse(r.payload),
      prev_hash: r.prev_hash,
      hash: r.hash,
    }));
  } else {
    events = [...source];
  }

  if (events.length === 0) {
    return { valid: true, count: 0 };
  }

  let expectedPrevHash = GENESIS_HASH;
  let expectedSeq = 1;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    // 1. Validate contiguous sequence number
    if (event.seq !== expectedSeq) {
      return {
        valid: false,
        brokenAtSeq: event.seq,
        reason: 'SEQUENCE_GAP_OR_FORK',
        count: events.length,
      };
    }

    // 2. Validate prev_hash linkage
    if (event.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAtSeq: event.seq,
        reason: 'PREV_HASH_MISMATCH',
        count: events.length,
      };
    }

    // 3. Recompute and validate event hash
    const recomputed = computeEventHash(event.prev_hash, {
      seq: event.seq,
      ts: event.ts,
      actor: event.actor,
      type: event.type,
      ref: event.ref,
      payload: event.payload,
    });

    if (recomputed !== event.hash) {
      return {
        valid: false,
        brokenAtSeq: event.seq,
        reason: 'HASH_TAMPERED',
        count: events.length,
      };
    }

    expectedPrevHash = event.hash;
    expectedSeq++;
  }

  return { valid: true, count: events.length };
}

/**
 * Backward compatibility alias for earlier helper signature.
 */
export function verifyLedgerIntegrity(events: readonly AuditEvent[]): { valid: boolean; brokenAtIndex?: number } {
  const res = verifyAuditLedger(events);
  if (!res.valid && res.brokenAtSeq !== undefined) {
    return {
      valid: false,
      brokenAtIndex: res.brokenAtSeq - 1,
    };
  }
  return { valid: true };
}
