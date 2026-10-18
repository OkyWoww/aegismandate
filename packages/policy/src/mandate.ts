import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MandateSchema,
  canonicalJson,
  type Mandate,
  type MandateStatus,
  type MandateWallet,
} from '@mandatepay/schemas';

/**
 * Valid state transitions for Mandate lifecycle (FR-2, FR-3, FR-4, FR-30):
 * - DRAFT -> ACTIVE | REVOKED
 * - ACTIVE -> EXPIRED | REVOKED | SUSPENDED
 * - SUSPENDED -> ACTIVE | REVOKED | EXPIRED
 * - EXPIRED -> (terminal)
 * - REVOKED -> (terminal)
 */
export const ALLOWED_MANDATE_TRANSITIONS: Record<MandateStatus, readonly MandateStatus[]> = {
  DRAFT: ['ACTIVE', 'REVOKED'],
  ACTIVE: ['EXPIRED', 'REVOKED', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'REVOKED', 'EXPIRED'],
  EXPIRED: [],
  REVOKED: [],
} as const;

export class InvalidMandateTransitionError extends Error {
  constructor(public readonly from: MandateStatus, public readonly to: MandateStatus) {
    super(`Invalid mandate status transition from '${from}' to '${to}'`);
    this.name = 'InvalidMandateTransitionError';
  }
}

/**
 * Returns true if transition from -> to is valid according to the Mandate lifecycle state machine.
 */
export function isValidMandateTransition(from: MandateStatus, to: MandateStatus): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_MANDATE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Asserts transition from -> to is valid; throws InvalidMandateTransitionError otherwise.
 */
export function assertValidMandateTransition(from: MandateStatus, to: MandateStatus): void {
  if (!isValidMandateTransition(from, to)) {
    throw new InvalidMandateTransitionError(from, to);
  }
}

/**
 * Pure expiry evaluation against an injected clock (NFR-6, rule.md §2.3).
 * Zero I/O, no Date.now() inside.
 */
export function isMandateExpired(
  mandate: Pick<Mandate, 'valid_until'>,
  clock: string | Date | number,
): boolean {
  const checkTime = typeof clock === 'number'
    ? clock
    : typeof clock === 'string'
      ? new Date(clock).getTime()
      : clock.getTime();

  const validUntilTime = typeof mandate.valid_until === 'number'
    ? mandate.valid_until
    : Date.parse(mandate.valid_until);

  if (Number.isNaN(checkTime) || Number.isNaN(validUntilTime)) {
    return true; // Fail closed if unparseable
  }

  return checkTime >= validUntilTime;
}

/**
 * Pure helper to extract the signable canonical JSON payload (excluding signature).
 */
export function canonicalMandateSignPayload(
  mandate: Mandate | Omit<Mandate, 'signature'>,
): string {
  // Omit the signature field so the signature does not attempt to sign itself
  const { signature: _sig, ...signableFields } = mandate as Mandate;
  return canonicalJson(signableFields);
}

/**
 * Computes deterministic HMAC-SHA256 signature for a mandate using MANDATE_HMAC_KEY (FR-6).
 * Output format: 'hmac-sha256:<hex>'
 */
export function computeMandateHmac(
  mandate: Mandate | Omit<Mandate, 'signature'>,
  secretKey: string,
): string {
  if (!secretKey) {
    throw new Error('MANDATE_HMAC_KEY must not be empty');
  }
  const payload = canonicalMandateSignPayload(mandate);
  const hmac = createHmac('sha256', secretKey).update(payload).digest('hex');
  return `hmac-sha256:${hmac}`;
}

/**
 * Pure function to sign a mandate document with HMAC-SHA256.
 */
export function signMandate<T extends Omit<Mandate, 'signature'>>(
  mandate: T,
  secretKey: string,
): T & { signature: string } {
  const signature = computeMandateHmac(mandate, secretKey);
  return {
    ...mandate,
    signature,
  };
}

/**
 * Pure verification of a Mandate HMAC-SHA256 signature against canonical JSON (FR-6).
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 */
export function verifyMandateSignature(mandate: Mandate, secretKey: string): boolean {
  if (!mandate.signature || !mandate.signature.startsWith('hmac-sha256:')) {
    return false;
  }
  if (!secretKey) {
    return false;
  }

  const expectedSignature = computeMandateHmac(mandate, secretKey);

  const actualBuf = Buffer.from(mandate.signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');

  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(actualBuf, expectedBuf);
}

export interface MandateUsableCheckResult {
  usable: boolean;
  reasonCode?:
    | 'MANDATE_NOT_ACTIVE'
    | 'MANDATE_SUSPENDED'
    | 'MANDATE_REVOKED'
    | 'MANDATE_EXPIRED'
    | 'INVALID_SIGNATURE'
    | 'SCHEMA_INVALID';
  details?: string;
}

/**
 * Deterministic, pure check if a mandate is active, unexpired, and cryptographically untampered.
 * Injected clock allows deterministic property and relative-clock testing.
 */
export function checkMandateUsable(
  mandate: Mandate,
  secretKey: string,
  clock: string | Date | number,
): MandateUsableCheckResult {
  // 1. Status checks
  if (mandate.status === 'DRAFT') {
    return {
      usable: false,
      reasonCode: 'MANDATE_NOT_ACTIVE',
      details: 'Mandate is still in DRAFT status',
    };
  }
  if (mandate.status === 'SUSPENDED') {
    return {
      usable: false,
      reasonCode: 'MANDATE_SUSPENDED',
      details: 'Mandate is temporarily SUSPENDED by circuit breaker',
    };
  }
  if (mandate.status === 'REVOKED') {
    return {
      usable: false,
      reasonCode: 'MANDATE_REVOKED',
      details: 'Mandate was REVOKED by user',
    };
  }
  if (mandate.status === 'EXPIRED') {
    return {
      usable: false,
      reasonCode: 'MANDATE_EXPIRED',
      details: 'Mandate is EXPIRED',
    };
  }

  // 2. Injected clock expiry check (FR-3, NFR-6)
  if (isMandateExpired(mandate, clock)) {
    return {
      usable: false,
      reasonCode: 'MANDATE_EXPIRED',
      details: `Mandate expired at ${mandate.valid_until}`,
    };
  }

  // 3. Cryptographic signature check (FR-6)
  if (!verifyMandateSignature(mandate, secretKey)) {
    return {
      usable: false,
      reasonCode: 'INVALID_SIGNATURE',
      details: 'HMAC-SHA256 signature mismatch over canonical JSON payload',
    };
  }

  // 4. Schema check
  const parseResult = MandateSchema.safeParse(mandate);
  if (!parseResult.success) {
    return {
      usable: false,
      reasonCode: 'SCHEMA_INVALID',
      details: parseResult.error.message,
    };
  }

  return { usable: true };
}

export type DraftMandateInput = Omit<Mandate, 'version' | 'status' | 'signature'>;

/**
 * Pure creation of a DRAFT mandate (FR-2).
 * Begins in 'DRAFT' status with unsigned placeholder signature.
 */
export function createDraftMandate(input: DraftMandateInput): Mandate {
  const draft: Mandate = {
    ...input,
    version: 1,
    status: 'DRAFT',
    signature: 'unsigned',
  };
  return MandateSchema.parse(draft);
}

/**
 * Pure activation of a DRAFT mandate (FR-2).
 * Links PayPal wallet, transitions status to 'ACTIVE', signs with HMAC-SHA256.
 */
export function activateDraftMandate(
  draft: Mandate,
  secretKey: string,
  wallet?: MandateWallet,
): Mandate {
  assertValidMandateTransition(draft.status, 'ACTIVE');

  const toActivate: Omit<Mandate, 'signature'> = {
    ...draft,
    status: 'ACTIVE',
    wallet: wallet ?? draft.wallet,
  };

  const signed = signMandate(toActivate, secretKey);
  return MandateSchema.parse(signed);
}

/**
 * Pure version incrementation for modified mandate documents (spec.md §3.1).
 * Mandates are immutable once signed; modifications yield a new version with version = prev.version + 1.
 */
export function createNewMandateVersion(
  prev: Mandate,
  updates: Partial<Omit<Mandate, 'mandate_id' | 'version' | 'created_at' | 'signature'>>,
  secretKey: string,
): Mandate {
  const newVersion: Omit<Mandate, 'signature'> = {
    ...prev,
    ...updates,
    version: prev.version + 1,
  };

  const signed = signMandate(newVersion, secretKey);
  return MandateSchema.parse(signed);
}
