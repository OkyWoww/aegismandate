import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, verifyAuditLedger } from '@mandatepay/audit';
import type { DatabaseConnection } from '@mandatepay/audit';
import { MandateService } from './mandate-service.js';
import type { DraftMandateInput } from '@mandatepay/policy';

const TEST_HMAC_KEY = 'secret_hmac_key_for_mandate_service_test_32chars';

function createSampleDraft(id = 'mnd_sample_001'): DraftMandateInput {
  return {
    mandate_id: id,
    owner_id: 'usr_test_shopper',
    agent_id: 'agt_shopper_01',
    currency: 'USD',
    valid_from: '2026-10-20T00:00:00Z',
    valid_until: '2026-10-20T12:00:00Z',
    total_budget_minor: 20000, // $200.00
    per_txn_limit_minor: 8000,  // $80.00
    auto_approve_limit_minor: 3000, // $30.00
    max_txns_per_hour: 3,
    allowed_merchants: ['mrc_demo_store'],
    allowed_categories: ['office_supplies', 'books'],
    max_items_per_intent: 5,
    max_pending_approvals: 3,
    suspend_after_denies: 5,
    step_up: { channel: 'dashboard', timeout_seconds: 300 },
    risk: { step_up_threshold: 40, deny_threshold: 75 },
    wallet: { type: 'paypal_vault', ref: 'pt_sample_vault_ref' },
    created_at: '2026-10-20T00:00:00Z',
  };
}

describe('MandateService (Control Plane Service, T-005)', () => {
  let db: DatabaseConnection;
  let simulatedTime: string;
  let service: MandateService;

  beforeEach(() => {
    // In-memory SQLite database
    db = openDb(':memory:');
    simulatedTime = '2026-10-20T01:00:00Z';
    service = new MandateService(db, TEST_HMAC_KEY, () => simulatedTime);
  });

  describe('1. Positive Mandate Creation & Activation (FR-1, FR-2, FR-6)', () => {
    it('creates draft, activates with HMAC signature, and verifies valid mandate', () => {
      const draft = service.createDraft(createSampleDraft('mnd_sample_001'));
      expect(draft.status).toBe('DRAFT');
      expect(draft.signature).toBe('unsigned');

      const active = service.activate('mnd_sample_001', {
        type: 'paypal_vault',
        ref: 'pt_activated_wallet_ref',
      });

      expect(active.status).toBe('ACTIVE');
      expect(active.signature).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);

      const fetched = service.getMandate('mnd_sample_001');
      expect(fetched).not.toBeNull();
      expect(fetched?.status).toBe('ACTIVE');
      expect(fetched?.wallet.ref).toBe('pt_activated_wallet_ref');

      // Check initial spend tracking row
      const spend = service.getSpend('mnd_sample_001');
      expect(spend.captured_minor).toBe(0);
      expect(spend.reserved_minor).toBe(0);

      // Verify audit chain
      const auditResult = verifyAuditLedger(db);
      expect(auditResult.valid).toBe(true);
      expect(auditResult.count).toBeGreaterThanOrEqual(2); // MANDATE_CREATED, MANDATE_ACTIVATED
    });
  });

  describe('2. Lifecycle Transitions & Injected Clock Expiry (FR-3, FR-4, FR-30, NFR-6)', () => {
    it('auto-expires mandate when clock advances past valid_until (FR-3, NFR-6)', () => {
      service.createDraft(createSampleDraft('mnd_sample_expiry'));
      service.activate('mnd_sample_expiry');

      // Before expiry: mandate is ACTIVE
      simulatedTime = '2026-10-20T11:59:59Z';
      expect(service.getMandate('mnd_sample_expiry')?.status).toBe('ACTIVE');

      // Past valid_until: 2026-10-20T12:00:00Z
      simulatedTime = '2026-10-20T12:00:01Z';
      const expired = service.getMandate('mnd_sample_expiry');
      expect(expired?.status).toBe('EXPIRED');

      // Further reservation attempts fail
      const reserveAttempt = service.reserve({
        mandateId: 'mnd_sample_expiry',
        intentId: 'int_expired_test',
        amountMinor: 1000,
      });
      expect(reserveAttempt.success).toBe(false);
      expect(reserveAttempt.reason).toBe('MANDATE_EXPIRED');
    });

    it('revokes mandate with immediate effect for in-flight intents and releases held reservations (FR-4)', () => {
      service.createDraft(createSampleDraft('mnd_sample_revoke'));
      service.activate('mnd_sample_revoke');

      // Create a held reservation
      const res = service.reserve({
        mandateId: 'mnd_sample_revoke',
        intentId: 'int_held_1',
        amountMinor: 2500,
      });
      expect(res.success).toBe(true);
      expect(service.getSpend('mnd_sample_revoke').reserved_minor).toBe(2500);

      // User revokes mandate
      const revoked = service.revoke('mnd_sample_revoke', 'User cancelled mandate');
      expect(revoked.status).toBe('REVOKED');

      // Reserved budget is immediately released
      expect(service.getSpend('mnd_sample_revoke').reserved_minor).toBe(0);

      // In-flight intent attempting reservation fails immediately
      const newReserve = service.reserve({
        mandateId: 'mnd_sample_revoke',
        intentId: 'int_in_flight_blocked',
        amountMinor: 1000,
      });
      expect(newReserve.success).toBe(false);
      expect(newReserve.reason).toBe('MANDATE_REVOKED');
    });

    it('circuit breaker: supports suspend and resume lifecycle (FR-30)', () => {
      service.createDraft(createSampleDraft('mnd_sample_cb'));
      service.activate('mnd_sample_cb');

      // Circuit breaker triggers SUSPENDED
      const suspended = service.suspend('mnd_sample_cb', '5 consecutive attacks detected');
      expect(suspended.status).toBe('SUSPENDED');

      // Reservations blocked while SUSPENDED
      const reserveBlocked = service.reserve({
        mandateId: 'mnd_sample_cb',
        intentId: 'int_cb_blocked',
        amountMinor: 1000,
      });
      expect(reserveBlocked.success).toBe(false);
      expect(reserveBlocked.reason).toBe('MANDATE_SUSPENDED');

      // User resumes mandate
      const resumed = service.resume('mnd_sample_cb');
      expect(resumed.status).toBe('ACTIVE');

      // Reservations now succeed again
      const reserveOk = service.reserve({
        mandateId: 'mnd_sample_cb',
        intentId: 'int_cb_ok',
        amountMinor: 1000,
      });
      expect(reserveOk.success).toBe(true);
    });
  });

  describe('3. Security / Tamper Rejection (AC-5, FR-6)', () => {
    it('SECURITY/TAMPER TEST: rejects mandate if SQLite payload is tampered', () => {
      service.createDraft(createSampleDraft('mnd_tamper_db'));
      const active = service.activate('mnd_tamper_db');

      // Tamper: manually alter SQLite json column (e.g. increase total budget from 20000 to 99999)
      const tamperedJson = JSON.stringify({
        ...active,
        total_budget_minor: 99999,
      });
      db.prepare('UPDATE mandates SET json = ? WHERE id = ?').run(tamperedJson, 'mnd_tamper_db');

      // Attempt reservation against tampered mandate
      const reserveResult = service.reserve({
        mandateId: 'mnd_tamper_db',
        intentId: 'int_tamper_try',
        amountMinor: 1000,
      });

      // Must be rejected due to INVALID_SIGNATURE
      expect(reserveResult.success).toBe(false);
      expect(reserveResult.reason).toBe('INVALID_SIGNATURE');
    });
  });

  describe('4. Reservation Accounting & Budget Invariant (FR-26, INV-8)', () => {
    it('enforces captured + reserved <= total_budget_minor and manages reservation lifecycle', () => {
      service.createDraft(createSampleDraft('mnd_budget_test'));
      service.activate('mnd_budget_test'); // Total budget = 20000 ($200.00), per_txn = 8000 ($80.00)

      // 1. Reserve $50.00 (5000 minor)
      const res1 = service.reserve({
        mandateId: 'mnd_budget_test',
        intentId: 'int_001',
        amountMinor: 5000,
      });
      expect(res1.success).toBe(true);
      expect(res1.spend?.reserved_minor).toBe(5000);
      expect(res1.spend?.captured_minor).toBe(0);

      // 2. Reserve $80.00 (8000 minor)
      const res2 = service.reserve({
        mandateId: 'mnd_budget_test',
        intentId: 'int_002',
        amountMinor: 8000,
      });
      expect(res2.success).toBe(true);
      expect(res2.spend?.reserved_minor).toBe(13000); // 5000 + 8000 = 13000

      // 3. Attempt to reserve $80.00 (8000 minor): 13000 + 8000 = 21000 > 20000 -> REJECT
      const resOver = service.reserve({
        mandateId: 'mnd_budget_test',
        intentId: 'int_over',
        amountMinor: 8000,
      });
      expect(resOver.success).toBe(false);
      expect(resOver.reason).toBe('BUDGET_EXCEEDED');

      // 4. Exceed per-txn cap ($90.00 > $80.00 per-txn cap) -> REJECT
      const resPerTxn = service.reserve({
        mandateId: 'mnd_budget_test',
        intentId: 'int_over_item',
        amountMinor: 9000,
      });
      expect(resPerTxn.success).toBe(false);
      expect(resPerTxn.reason).toBe('ITEM_CAP_EXCEEDED');

      // 5. Release reservation int_001 ($50.00 released)
      const releaseRes = service.releaseReservation('int_001', 'User rejected approval');
      expect(releaseRes.success).toBe(true);
      expect(releaseRes.releasedMinor).toBe(5000);
      expect(service.getSpend('mnd_budget_test').reserved_minor).toBe(8000);

      // 6. Capture reservation int_002 ($80.00 captured)
      const captureRes = service.captureReservation('int_002', 8000);
      expect(captureRes.success).toBe(true);
      expect(captureRes.capturedMinor).toBe(8000);

      const finalSpend = service.getSpend('mnd_budget_test');
      expect(finalSpend.reserved_minor).toBe(0);
      expect(finalSpend.captured_minor).toBe(8000);

      // 7. Re-check ledger integrity
      const ledgerVerify = verifyAuditLedger(db);
      expect(ledgerVerify.valid).toBe(true);
    });

    it('handles idempotent reservation submits with identical intentId', () => {
      service.createDraft(createSampleDraft('mnd_idempotent'));
      service.activate('mnd_idempotent');

      const first = service.reserve({
        mandateId: 'mnd_idempotent',
        intentId: 'int_idempotent_1',
        amountMinor: 3000,
      });
      expect(first.success).toBe(true);

      // Submitting again with identical intent_id
      const second = service.reserve({
        mandateId: 'mnd_idempotent',
        intentId: 'int_idempotent_1',
        amountMinor: 3000,
      });
      expect(second.success).toBe(true);
      expect(second.reservation?.id).toBe(first.reservation?.id);

      // Spend was NOT double-counted
      expect(service.getSpend('mnd_idempotent').reserved_minor).toBe(3000);
    });
  });

  describe('5. Immutability & Version Incrementation (spec.md §3.1)', () => {
    it('creates version 2 when mandate configuration is updated', () => {
      service.createDraft(createSampleDraft('mnd_version_test'));
      const v1 = service.activate('mnd_version_test');
      expect(v1.version).toBe(1);

      const v2 = service.updateMandateConfig('mnd_version_test', {
        total_budget_minor: 50000,
        per_txn_limit_minor: 15000,
      });

      expect(v2.version).toBe(2);
      expect(v2.total_budget_minor).toBe(50000);
      expect(v2.per_txn_limit_minor).toBe(15000);
      expect(v2.signature).not.toBe(v1.signature);

      const fetched = service.getMandate('mnd_version_test');
      expect(fetched?.version).toBe(2);
      expect(fetched?.total_budget_minor).toBe(50000);

      // Audit chain verifies
      expect(verifyAuditLedger(db).valid).toBe(true);
    });
  });
});
