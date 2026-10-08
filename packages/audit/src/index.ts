import { createHash } from 'node:crypto';
import type { AuditEvent } from '@mandatepay/schemas';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Computes sha256 hash chaining previousHash + sequenceNumber + timestamp + serialized payload
 */
export function computeEventHash(
  previousHash: string,
  sequenceNumber: number,
  eventType: string,
  timestamp: string,
  payload: Record<string, unknown>
): string {
  const content = JSON.stringify({
    previousHash,
    sequenceNumber,
    eventType,
    timestamp,
    payload,
  });
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

    if (event.previousHash !== expectedPrevHash) {
      return { valid: false, brokenAtIndex: i };
    }

    const calculated = computeEventHash(
      event.previousHash,
      event.sequenceNumber,
      event.eventType,
      event.timestamp,
      event.payload
    );

    if (calculated !== event.currentHash) {
      return { valid: false, brokenAtIndex: i };
    }

    expectedPrevHash = event.currentHash;
  }

  return { valid: true };
}
