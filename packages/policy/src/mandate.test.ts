import { describe, it, expect } from 'vitest';
import {
  createDraftMandate,
  activateDraftMandate,
  createNewMandateVersion,
  verifyMandateSignature,
  computeMandateHmac,
  checkMandateUsable,
  isMandateExpired,
  isValidMandateTransition,
  assertValidMandateTransition,
  InvalidMandateTransitionError,
  type DraftMandateInput,
} from './mandate.js';
import type { Mandate } from '@mandatepay/schemas';

const TEST_HMAC_KEY = 'test_secret_hmac_key_for_mandatepay_testing_32chars';

const sampleDraftInput: DraftMandateInput = {
  mandate_id: 'mnd_01HXYZ1234567890ABCDEF',
  owner_id: 'usr_demo_owner',
  agent_id: 'agt_shopper_1',
  currency: 'USD',
  valid_from: '2026-10-20T00:00:00Z',
  valid_until: '2026-10-20T12:00:00Z',
  total_budget_minor: 20000,
  per_txn_limit_minor: 8000,
  auto_approve_limit_minor: 3000,
  max_txns_per_hour: 3,
  allowed_merchants: ['mrc_demo_store'],
  allowed_categories: ['office_supplies', 'books'],
  max_items_per_intent: 5,
  max_pending_approvals: 3,
  suspend_after_denies: 5,
  step_up: { channel: 'dashboard', timeout_seconds: 300 },
  risk: { step_up_threshold: 40, deny_threshold: 75 },
  wallet: { type: 'paypal_vault', ref: 'pt_sample_ref_123' },
  created_at: '2026-10-20T00:00:00Z',
};

describe('Mandate Lifecycle State Machine (FR-2, FR-3, FR-4, FR-30)', () => {
  it('allows valid lifecycle transitions', () => {
    // DRAFT -> ACTIVE
    expect(isValidMandateTransition('DRAFT', 'ACTIVE')).toBe(true);
    // DRAFT -> REVOKED
    expect(isValidMandateTransition('DRAFT', 'REVOKED')).toBe(true);
    // ACTIVE -> SUSPENDED (Circuit breaker)
    expect(isValidMandateTransition('ACTIVE', 'SUSPENDED')).toBe(true);
    // SUSPENDED -> ACTIVE (User resume)
    expect(isValidMandateTransition('SUSPENDED', 'ACTIVE')).toBe(true);
    // ACTIVE -> EXPIRED (TTL reached)
    expect(isValidMandateTransition('ACTIVE', 'EXPIRED')).toBe(true);
    // ACTIVE -> REVOKED (User cancel)
    expect(isValidMandateTransition('ACTIVE', 'REVOKED')).toBe(true);
    // SUSPENDED -> REVOKED
    expect(isValidMandateTransition('SUSPENDED', 'REVOKED')).toBe(true);
    // SUSPENDED -> EXPIRED
    expect(isValidMandateTransition('SUSPENDED', 'EXPIRED')).toBe(true);
    // Self transition
    expect(isValidMandateTransition('ACTIVE', 'ACTIVE')).toBe(true);
  });

  it('strictly rejects invalid transitions', () => {
    // Terminal states cannot transition
    expect(isValidMandateTransition('EXPIRED', 'ACTIVE')).toBe(false);
    expect(isValidMandateTransition('REVOKED', 'ACTIVE')).toBe(false);
    expect(isValidMandateTransition('EXPIRED', 'REVOKED')).toBe(false);
    expect(isValidMandateTransition('REVOKED', 'EXPIRED')).toBe(false);

    // DRAFT cannot jump to SUSPENDED or EXPIRED
    expect(isValidMandateTransition('DRAFT', 'SUSPENDED')).toBe(false);
    expect(isValidMandateTransition('DRAFT', 'EXPIRED')).toBe(false);

    expect(() => assertValidMandateTransition('EXPIRED', 'ACTIVE')).toThrow(
      InvalidMandateTransitionError,
    );
    expect(() => assertValidMandateTransition('REVOKED', 'ACTIVE')).toThrow(
      InvalidMandateTransitionError,
    );
    expect(() => assertValidMandateTransition('DRAFT', 'SUSPENDED')).toThrow(
      InvalidMandateTransitionError,
    );
  });
});

describe('HMAC-SHA256 Signature & Canonical Serialization (FR-6)', () => {
  it('creates draft, activates with HMAC signature, and verifies valid mandate', () => {
    const draft = createDraftMandate(sampleDraftInput);
    expect(draft.status).toBe('DRAFT');
    expect(draft.version).toBe(1);
    expect(draft.signature).toBe('unsigned');

    const active = activateDraftMandate(draft, TEST_HMAC_KEY);
    expect(active.status).toBe('ACTIVE');
    expect(active.signature).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);

    const isValid = verifyMandateSignature(active, TEST_HMAC_KEY);
    expect(isValid).toBe(true);
  });

  it('rejects signature if verified with incorrect HMAC key', () => {
    const draft = createDraftMandate(sampleDraftInput);
    const active = activateDraftMandate(draft, TEST_HMAC_KEY);

    const isWrongKeyValid = verifyMandateSignature(active, 'completely_wrong_key_1234567890');
    expect(isWrongKeyValid).toBe(false);
  });

  it('SECURITY/TAMPER TEST: Altering a single byte in mandate JSON causes signature verification failure (AC-5, FR-6)', () => {
    const draft = createDraftMandate(sampleDraftInput);
    const active = activateDraftMandate(draft, TEST_HMAC_KEY);

    // Tamper 1: Increase budget by 1 cent
    const tamperedBudget: Mandate = {
      ...active,
      total_budget_minor: active.total_budget_minor + 1,
    };
    expect(verifyMandateSignature(tamperedBudget, TEST_HMAC_KEY)).toBe(false);

    // Tamper 2: Alter allowed merchants list
    const tamperedMerchants: Mandate = {
      ...active,
      allowed_merchants: [...active.allowed_merchants, 'mrc_evil_store'],
    };
    expect(verifyMandateSignature(tamperedMerchants, TEST_HMAC_KEY)).toBe(false);

    // Tamper 3: Alter valid_until timestamp
    const tamperedExpiry: Mandate = {
      ...active,
      valid_until: '2026-10-21T00:00:00Z',
    };
    expect(verifyMandateSignature(tamperedExpiry, TEST_HMAC_KEY)).toBe(false);

    // Tamper 4: Alter owner_id
    const tamperedOwner: Mandate = {
      ...active,
      owner_id: 'usr_attacker',
    };
    expect(verifyMandateSignature(tamperedOwner, TEST_HMAC_KEY)).toBe(false);

    // Tamper 5: Alter signature string itself
    const tamperedSig: Mandate = {
      ...active,
      signature: active.signature.slice(0, -1) + (active.signature.endsWith('a') ? 'b' : 'a'),
    };
    expect(verifyMandateSignature(tamperedSig, TEST_HMAC_KEY)).toBe(false);
  });
});

describe('Injected Clock Expiry & Usability Checks (NFR-6, FR-3)', () => {
  it('correctly evaluates expiry against relative injected clock', () => {
    const draft = createDraftMandate(sampleDraftInput);
    const active = activateDraftMandate(draft, TEST_HMAC_KEY);

    // 1 hour before expiry
    const beforeExpiry = '2026-10-20T11:00:00Z';
    expect(isMandateExpired(active, beforeExpiry)).toBe(false);

    // Exactly at expiry
    const atExpiry = '2026-10-20T12:00:00Z';
    expect(isMandateExpired(active, atExpiry)).toBe(true);

    // 1 second after expiry
    const afterExpiry = '2026-10-20T12:00:01Z';
    expect(isMandateExpired(active, afterExpiry)).toBe(true);
  });

  it('checkMandateUsable verifies active status, unexpired, and cryptographic signature', () => {
    const draft = createDraftMandate(sampleDraftInput);
    const active = activateDraftMandate(draft, TEST_HMAC_KEY);

    const normalClock = '2026-10-20T06:00:00Z';
    const checkActive = checkMandateUsable(active, TEST_HMAC_KEY, normalClock);
    expect(checkActive.usable).toBe(true);

    // Check with expired clock
    const expiredClock = '2026-10-20T13:00:00Z';
    const checkExpired = checkMandateUsable(active, TEST_HMAC_KEY, expiredClock);
    expect(checkExpired.usable).toBe(false);
    expect(checkExpired.reasonCode).toBe('MANDATE_EXPIRED');

    // Check draft mandate
    const checkDraft = checkMandateUsable(draft, TEST_HMAC_KEY, normalClock);
    expect(checkDraft.usable).toBe(false);
    expect(checkDraft.reasonCode).toBe('MANDATE_NOT_ACTIVE');

    // Check suspended mandate
    const suspended: Mandate = {
      ...active,
      status: 'SUSPENDED',
      signature: computeMandateHmac({ ...active, status: 'SUSPENDED' }, TEST_HMAC_KEY),
    };
    const checkSuspended = checkMandateUsable(suspended, TEST_HMAC_KEY, normalClock);
    expect(checkSuspended.usable).toBe(false);
    expect(checkSuspended.reasonCode).toBe('MANDATE_SUSPENDED');

    // Check revoked mandate
    const revoked: Mandate = {
      ...active,
      status: 'REVOKED',
      signature: computeMandateHmac({ ...active, status: 'REVOKED' }, TEST_HMAC_KEY),
    };
    const checkRevoked = checkMandateUsable(revoked, TEST_HMAC_KEY, normalClock);
    expect(checkRevoked.usable).toBe(false);
    expect(checkRevoked.reasonCode).toBe('MANDATE_REVOKED');
  });
});

describe('Document Immutability & Version Incrementing (spec.md §3.1)', () => {
  it('increments version on modification and produces a valid re-signed mandate', () => {
    const draft = createDraftMandate(sampleDraftInput);
    const v1 = activateDraftMandate(draft, TEST_HMAC_KEY);
    expect(v1.version).toBe(1);

    const v2 = createNewMandateVersion(
      v1,
      {
        total_budget_minor: 35000,
        per_txn_limit_minor: 10000,
      },
      TEST_HMAC_KEY,
    );

    expect(v2.version).toBe(2);
    expect(v2.total_budget_minor).toBe(35000);
    expect(v2.per_txn_limit_minor).toBe(10000);
    expect(v2.mandate_id).toBe(v1.mandate_id);
    expect(v2.signature).not.toBe(v1.signature);
    expect(verifyMandateSignature(v2, TEST_HMAC_KEY)).toBe(true);

    // v1 remains unchanged (immutable)
    expect(v1.version).toBe(1);
    expect(v1.total_budget_minor).toBe(20000);
    expect(verifyMandateSignature(v1, TEST_HMAC_KEY)).toBe(true);
  });
});
