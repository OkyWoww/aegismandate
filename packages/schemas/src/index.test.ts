import { describe, it, expect } from 'vitest';
import {
  MandateSchema,
  PurchaseIntentProposalSchema,
  DecisionSchema,
  AuditEventSchema,
  deepKeyScan,
} from './index.js';

describe('Shared Schemas (packages/schemas) — Spec §3 Compliance', () => {
  // ============================================================================
  // 1. SPEC §3.1 MANDATE FIXTURES
  // ============================================================================
  describe('MandateSchema (spec.md §3.1)', () => {
    const validMandateFixture = {
      mandate_id: 'mnd_01H00000000000000000000001',
      version: 1,
      owner_id: 'usr_demo',
      agent_id: 'agt_shopper_1',
      status: 'ACTIVE' as const,
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
      step_up: { channel: 'dashboard' as const, timeout_seconds: 300 },
      risk: { step_up_threshold: 40, deny_threshold: 75 },
      wallet: { type: 'paypal_vault', ref: 'pt_123' },
      created_at: '2026-10-20T00:00:00Z',
      signature: 'hmac-sha256:abcdef0123456789',
    };

    it('passes positive fixture from spec.md §3.1', () => {
      const parsed = MandateSchema.safeParse(validMandateFixture);
      expect(parsed.success).toBe(true);
    });

    it('rejects floating point numbers in monetary fields (rule.md §2)', () => {
      const invalid = { ...validMandateFixture, total_budget_minor: 200.5 };
      const parsed = MandateSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('rejects unrecognized keys (.strict())', () => {
      const invalid = { ...validMandateFixture, unauthorized_extra: 'exploit' };
      const parsed = MandateSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('rejects when auto_approve_limit_minor > per_txn_limit_minor', () => {
      const invalid = {
        ...validMandateFixture,
        auto_approve_limit_minor: 9000,
        per_txn_limit_minor: 8000,
      };
      const parsed = MandateSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('rejects when per_txn_limit_minor > total_budget_minor', () => {
      const invalid = {
        ...validMandateFixture,
        per_txn_limit_minor: 25000,
        total_budget_minor: 20000,
      };
      const parsed = MandateSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('rejects when valid_until <= valid_from', () => {
      const invalid = {
        ...validMandateFixture,
        valid_from: '2026-10-20T12:00:00Z',
        valid_until: '2026-10-20T00:00:00Z',
      };
      const parsed = MandateSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('rejects empty allowed_merchants array', () => {
      const invalid = { ...validMandateFixture, allowed_merchants: [] };
      const parsed = MandateSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  // ============================================================================
  // 2. SPEC §3.2 PURCHASE INTENT PROPOSAL FIXTURES
  // ============================================================================
  describe('PurchaseIntentProposalSchema (spec.md §3.2)', () => {
    const validProposalFixture = {
      intent_id: 'int_01H00000000000000000000001',
      mandate_id: 'mnd_01H00000000000000000000001',
      merchant_ref: 'mrc_demo_store',
      items: [{ sku: 'SKU-PEN-12', qty: 2, claimed_unit_price_minor: 450 }],
      claimed_total_minor: 900,
      currency: 'USD',
      user_goal_ref: 'msg_123',
      rationale: 'User asked for two pens.',
      provenance: {
        sources: [
          { kind: 'user' as const, ref: 'msg_123', trust: 'user' as const },
          {
            kind: 'web' as const,
            ref: 'https://demo-store.local/p/SKU-PEN-12',
            trust: 'untrusted_web' as const,
            content_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
        ],
      },
    };

    it('passes positive fixture from spec.md §3.2', () => {
      const parsed = PurchaseIntentProposalSchema.safeParse(validProposalFixture);
      expect(parsed.success).toBe(true);
    });

    it('rejects unknown/extra properties (.strict() at any depth)', () => {
      const withExtraTop = { ...validProposalFixture, extra_field: 123 };
      expect(PurchaseIntentProposalSchema.safeParse(withExtraTop).success).toBe(false);

      const withExtraNested = {
        ...validProposalFixture,
        items: [{ sku: 'SKU-PEN-12', qty: 2, claimed_unit_price_minor: 450, bonus: 'free' }],
      };
      expect(PurchaseIntentProposalSchema.safeParse(withExtraNested).success).toBe(false);
    });

    it('rejects invalid SKU pattern', () => {
      const invalid = {
        ...validProposalFixture,
        items: [{ sku: 'bad sku with spaces!', qty: 2, claimed_unit_price_minor: 450 }],
      };
      expect(PurchaseIntentProposalSchema.safeParse(invalid).success).toBe(false);
    });

    it('rejects claimed_total_minor mismatch against items sum', () => {
      const invalid = { ...validProposalFixture, claimed_total_minor: 850 };
      const parsed = PurchaseIntentProposalSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('rejects floating point currency amounts', () => {
      const invalid = {
        ...validProposalFixture,
        claimed_total_minor: 9.0,
        items: [{ sku: 'SKU-PEN-12', qty: 2, claimed_unit_price_minor: 4.5 }],
      };
      const parsed = PurchaseIntentProposalSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('rejects rationale exceeding 280 characters', () => {
      const invalid = { ...validProposalFixture, rationale: 'A'.repeat(281) };
      const parsed = PurchaseIntentProposalSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  // ============================================================================
  // 3. SPEC §3.3 DECISION FIXTURES
  // ============================================================================
  describe('DecisionSchema (spec.md §3.3)', () => {
    const validDecisionFixture = {
      decision_id: 'dec_01H00000000000000000000001',
      intent_id: 'int_01H00000000000000000000001',
      verdict: 'DENY' as const,
      reason_codes: ['PAYEE_OVERRIDE_ATTEMPT', 'RISK_SCORE_HIGH'],
      risk: {
        score: 88,
        signals: ['hidden_text', 'instruction_phrase', 'foreign_payee_hint'],
      },
      policy_trace: [
        { rule: 'P-00', result: 'pass' as const },
        { rule: 'P-03', result: 'deny' as const, detail: "payload contained forbidden field 'recipient'" },
      ],
      verified_total_minor: null,
      decided_at: '2026-10-20T08:15:03Z',
      engine_version: '0.1.0',
    };

    it('passes positive fixture from spec.md §3.3', () => {
      const parsed = DecisionSchema.safeParse(validDecisionFixture);
      expect(parsed.success).toBe(true);
    });

    it('rejects invalid verdict', () => {
      const invalid = { ...validDecisionFixture, verdict: 'MAYBE' };
      expect(DecisionSchema.safeParse(invalid).success).toBe(false);
    });

    it('rejects extra unrecognized fields', () => {
      const invalid = { ...validDecisionFixture, bypass_token: 'xyz' };
      expect(DecisionSchema.safeParse(invalid).success).toBe(false);
    });
  });

  // ============================================================================
  // 4. SPEC §3.5 AUDIT EVENT FIXTURES
  // ============================================================================
  describe('AuditEventSchema (spec.md §3.5)', () => {
    const validAuditEventFixture = {
      seq: 42,
      ts: '2026-10-20T08:15:03Z',
      actor: 'control_plane' as const,
      type: 'INTENT_DECIDED',
      ref: 'int_01H00000000000000000000001',
      payload: { verdict: 'DENY', reason: 'PAYEE_OVERRIDE_ATTEMPT' },
      prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
      hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    };

    it('passes positive fixture from spec.md §3.5', () => {
      const parsed = AuditEventSchema.safeParse(validAuditEventFixture);
      expect(parsed.success).toBe(true);
    });

    it('rejects negative sequence numbers', () => {
      const invalid = { ...validAuditEventFixture, seq: -1 };
      expect(AuditEventSchema.safeParse(invalid).success).toBe(false);
    });

    it('rejects invalid actor', () => {
      const invalid = { ...validAuditEventFixture, actor: 'hacker' };
      expect(AuditEventSchema.safeParse(invalid).success).toBe(false);
    });
  });

  // ============================================================================
  // 5. DEEP KEY SCAN HELPER (spec.md §3.2 & P-03)
  // ============================================================================
  describe('deepKeyScan helper (P-03 / A-12 defense-in-depth)', () => {
    it('passes clean payload without forbidden keys or values', () => {
      const cleanPayload = {
        intent_id: 'int_01',
        items: [{ sku: 'SKU-PEN', qty: 2 }],
        notes: 'Two pencils please.',
      };
      const res = deepKeyScan(cleanPayload);
      expect(res.hasForbiddenKey).toBe(false);
      expect(res.hasForbiddenValue).toBe(false);
      expect(res.violations).toHaveLength(0);
    });

    it('detects nested forbidden payee key in items array', () => {
      const evilPayload = {
        intent_id: 'int_01',
        items: [{ sku: 'SKU-PEN', recipient: 'attacker@evil.test' }],
      };
      const res = deepKeyScan(evilPayload);
      expect(res.hasForbiddenKey).toBe(true);
      expect(res.violations.some((v) => v.detail.includes('recipient'))).toBe(true);
    });

    it('detects forbidden keys: account, destination, wallet, iban, email, transfer', () => {
      const forbiddenKeys = [
        { destination: '0x123' },
        { account_id: '123' },
        { wallet: 'crypto' },
        { iban: 'DE89370400440532013000' },
        { transfer_to: 'user' },
      ];

      for (const obj of forbiddenKeys) {
        const res = deepKeyScan(obj);
        expect(res.hasForbiddenKey).toBe(true);
      }
    });

    it('detects email address inside free-text rationale or provenance ref', () => {
      const evilPayload = {
        rationale: 'Send confirmation copy to hacker@evil.com immediately',
      };
      const res = deepKeyScan(evilPayload);
      expect(res.hasForbiddenValue).toBe(true);
      expect(res.violations.some((v) => v.detail.includes('email-like'))).toBe(true);
    });

    it('detects IBAN inside nested free-text field', () => {
      const evilPayload = {
        provenance: {
          sources: [{ ref: 'GB82WEST12345698765432' }],
        },
      };
      const res = deepKeyScan(evilPayload);
      expect(res.hasForbiddenValue).toBe(true);
      expect(res.violations.some((v) => v.detail.includes('IBAN'))).toBe(true);
    });

    it('detects prototype pollution keys (__proto__, constructor)', () => {
      const evilPayload = JSON.parse('{"__proto__": {"admin": true}, "valid": true}');
      const res = deepKeyScan(evilPayload);
      expect(res.hasForbiddenKey).toBe(true);
    });
  });
});
