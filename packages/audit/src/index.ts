import { createHash } from 'node:crypto';
import type { AuditEvent } from '@mandatepay/schemas';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Computes sha256 hash chaining prev_hash + canonical_json per spec.md §3.5
 * hash = sha256(prev_hash || canonical_json(seq,ts,actor,type,ref,payload))
 */
export function computeEventHash(
  prevHash: string,
  seq: number,
  ts: string,
  actor: string,
  type: string,
  ref: string,
  payload: Record<string, unknown>,
): string {
  const content = `${prevHash}||${JSON.stringify({
    seq,
    ts,
    actor,
    type,
    ref,
    payload,
  })}`;
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Validates cryptographic chain integrity of a list of audit events
 */
export function verifyLedgerIntegrity(events: readonly AuditEvent[]): { valid: boolean; brokenAtIndex?: number } {
  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;

    if (event.prev_hash !== expectedPrevHash) {
      return { valid: false, brokenAtIndex: i };
    }

    const calculated = computeEventHash(
      event.prev_hash,
      event.seq,
      event.ts,
      event.actor,
      event.type,
      event.ref,
      event.payload,
    );

    if (calculated !== event.hash) {
      return { valid: false, brokenAtIndex: i };
    }

    expectedPrevHash = event.hash;
  }

  return { valid: true };
}
