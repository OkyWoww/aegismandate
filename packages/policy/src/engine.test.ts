import { describe, it, expect } from 'vitest';
import {
  evaluatePolicy,
  evaluatePolicyRules,
  type PolicyEvaluationFacts,
} from './engine.js';
import { signMandate } from './mandate.js';
import type { Mandate, PurchaseIntentProposal } from '@mandatepay/schemas';

const TEST_HMAC_KEY = 'test_policy_engine_hmac_secret_key_32chars!';

function createValidMandate(overrides: Partial<Mandate> = {}): Mandate {
  const base: Omit<Mandate, 'signature'> = {
    mandate_id: 'mnd_test_policy_001',
    version: 1,
    owner_id: 'usr_alice',
    agent_id: 'agt_shopper_1',
    status: 'ACTIVE',
    currency: 'USD',
    valid_from: '2026-10-20T00:00:00Z',
    valid_until: '2026-10-20T20:00:00Z',
    total_budget_minor: 20000, // $200.00
    per_txn_limit_minor: 8000, // $80.00
    auto_approve_limit_minor: 3000, // $30.00
    max_txns_per_hour: 3,
    allowed_merchants: ['mrc_demo_store'],
    allowed_categories: ['office_supplies', 'books'],
    max_items_per_intent: 5,
    max_pending_approvals: 3,
    suspend_after_denies: 5,
    step_up: { channel: 'dashboard', timeout_seconds: 300 },
    risk: { step_up_threshold: 40, deny_threshold: 75 },
    wallet: { type: 'paypal_vault', ref: 'pt_sandbox_test' },
    created_at: '2026-10-20T00:00:00Z',
    ...overrides,
  };
  return signMandate(base, TEST_HMAC_KEY);
}

function createValidProposal(overrides: Partial<PurchaseIntentProposal> = {}): PurchaseIntentProposal {
  return {
    intent_id: 'int_valid_policy_001',
    mandate_id: 'mnd_test_policy_001',
    merchant_ref: 'mrc_demo_store',
    items: [
      {
        sku: 'SKU-PEN-PACK',
        qty: 1,
        claimed_unit_price_minor: 900,
      },
    ],
    claimed_total_minor: 900,
    currency: 'USD',
    user_goal_ref: 'msg_user_request_123',
    rationale: 'User asked for pens for office work',
    provenance: {
      sources: [
        { kind: 'user', ref: 'msg_user_request_123', trust: 'user' },
        { kind: 'web', ref: 'https://demo-store.local/p/SKU-PEN-PACK', trust: 'untrusted_web' },
      ],
    },
    ...overrides,
  };
}

function createValidFacts(overrides: Partial<PolicyEvaluationFacts> = {}): PolicyEvaluationFacts {
  return {
    verifiedItems: [
      {
        sku: 'SKU-PEN-PACK',
        name: 'Ballpoint Pens 10-pack',
        category: 'office_supplies',
        priceMinor: 900,
      },
    ],
    verifiedTotalMinor: 900,
    capturedMinor: 0,
    reservedMinor: 0,
    ...overrides,
  };
}

describe('Full Policy Engine P-00 through P-12 (spec.md §4, FR-8, FR-9, FR-11)', () => {
  const clockNow = '2026-10-20T10:00:00Z';

  // --------------------------------------------------------------------------
  // Rule P-00: Mandate checks
  // --------------------------------------------------------------------------
  describe('Rule P-00: Mandate exists, signature valid, status=ACTIVE, clock in [valid_from, valid_until]', () => {
    it('DENY MANDATE_NOT_FOUND if mandate is null/undefined', () => {
      const decision = evaluatePolicy(null, createValidProposal(), createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MANDATE_NOT_FOUND');
    });

    it('DENY MANDATE_INVALID if mandate signature is tampered', () => {
      const mandate = createValidMandate();
      const tampered = { ...mandate, signature: 'hmac-sha256:invalid_bogus_sig' };
      const decision = evaluatePolicy(tampered, createValidProposal(), createValidFacts(), clockNow, {
        hmacKey: TEST_HMAC_KEY,
      });
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MANDATE_INVALID');
    });

    it('DENY MANDATE_REVOKED if mandate status is REVOKED', () => {
      const mandate = createValidMandate({ status: 'REVOKED' });
      const decision = evaluatePolicy(mandate, createValidProposal(), createValidFacts(), clockNow, {
        hmacKey: TEST_HMAC_KEY,
      });
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MANDATE_REVOKED');
    });

    it('DENY MANDATE_EXPIRED if clock is past valid_until', () => {
      const mandate = createValidMandate({ valid_until: '2026-10-20T08:00:00Z' });
      const decision = evaluatePolicy(mandate, createValidProposal(), createValidFacts(), '2026-10-20T09:00:00Z', {
        hmacKey: TEST_HMAC_KEY,
      });
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MANDATE_EXPIRED');
    });

    it('DENY MANDATE_NOT_YET_VALID if clock is before valid_from', () => {
      const mandate = createValidMandate({ valid_from: '2026-10-20T12:00:00Z' });
      const decision = evaluatePolicy(mandate, createValidProposal(), createValidFacts(), '2026-10-20T09:00:00Z', {
        hmacKey: TEST_HMAC_KEY,
      });
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MANDATE_NOT_YET_VALID');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-01: Proposal Schema Validation
  // --------------------------------------------------------------------------
  describe('Rule P-01: Strict Schema Validation', () => {
    it('DENY MALFORMED if proposal violates strict schema (e.g. negative qty)', () => {
      const invalidProposal = {
        ...createValidProposal(),
        items: [{ sku: 'SKU-PEN-PACK', qty: -1, claimed_unit_price_minor: 900 }],
      };
      const decision = evaluatePolicy(
        createValidMandate(),
        invalidProposal as PurchaseIntentProposal,
        createValidFacts(),
        clockNow,
      );
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MALFORMED');
    });

    it('DENY MALFORMED if proposal contains unrecognized top-level properties', () => {
      const invalidProposal = {
        ...createValidProposal(),
        unrecognized_evil_field: 'malicious',
      };
      const decision = evaluatePolicy(
        createValidMandate(),
        invalidProposal as PurchaseIntentProposal,
        createValidFacts(),
        clockNow,
      );
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MALFORMED');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-02: Idempotency
  // --------------------------------------------------------------------------
  describe('Rule P-02: Idempotency (Unseen intent_id)', () => {
    it('returns stored decision immediately when intent_id matches storedDecision', () => {
      const storedDecision = {
        decision_id: 'dec_stored_cache_99',
        intent_id: 'int_valid_policy_001',
        verdict: 'ALLOW' as const,
        reason_codes: ['APPROVED'],
        risk: { score: 0, signals: [] },
        policy_trace: [{ rule: 'P-12', result: 'pass' as const, detail: 'cached' }],
        verified_total_minor: 900,
        decided_at: '2026-10-20T05:00:00Z',
        engine_version: '0.1.0',
      };
      const facts = createValidFacts({ storedDecision });
      const decision = evaluatePolicy(createValidMandate(), createValidProposal(), facts, clockNow);
      expect(decision.decision_id).toBe('dec_stored_cache_99');
      expect(decision.decided_at).toBe('2026-10-20T05:00:00Z');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-03: Payee security
  // --------------------------------------------------------------------------
  describe('Rule P-03: Payee Security (Recursive Deep Key Scan & Payee Allowlist)', () => {
    it('DENY PAYEE_OVERRIDE_ATTEMPT when forbidden payee key is injected', () => {
      const rawJson = JSON.stringify({
        ...createValidProposal(),
        recipient: 'attacker@evil.com',
      });
      const decision = evaluatePolicy(createValidMandate(), createValidProposal(), createValidFacts(), clockNow, {
        rawJson,
      });
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('PAYEE_OVERRIDE_ATTEMPT');
    });

    it('DENY MERCHANT_NOT_ALLOWED when merchant is not in allowed_merchants', () => {
      const proposal = createValidProposal({ merchant_ref: 'mrc_unapproved_store' });
      const decision = evaluatePolicy(createValidMandate(), proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MERCHANT_NOT_ALLOWED');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-04: Server-verified price & total
  // --------------------------------------------------------------------------
  describe('Rule P-04: SKU exists, price * qty = verified_total = claimed_total', () => {
    it('DENY UNKNOWN_SKU when SKU is not in merchant catalog', () => {
      const proposal = createValidProposal({
        items: [{ sku: 'SKU-UNKNOWN-ITEM', qty: 1, claimed_unit_price_minor: 900 }],
      });
      const decision = evaluatePolicy(createValidMandate(), proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('UNKNOWN_SKU');
    });

    it('DENY PRICE_MISMATCH when claimed unit price != server catalog price', () => {
      const proposal = createValidProposal({
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 500 }], // claimed 500 but server is 900
        claimed_total_minor: 500,
      });
      const decision = evaluatePolicy(createValidMandate(), proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('PRICE_MISMATCH');
    });

    it('DENY PRICE_MISMATCH when claimed total != server verified total', () => {
      const proposal = createValidProposal({
        claimed_total_minor: 1200, // claimed 1200 but verified total is 900
      });
      const decision = evaluatePolicy(createValidMandate(), proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('PRICE_MISMATCH');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-05: Currency matching
  // --------------------------------------------------------------------------
  describe('Rule P-05: Currency matching mandate', () => {
    it('DENY CURRENCY_NOT_ALLOWED when proposal currency does not match mandate', () => {
      const proposal = createValidProposal({ currency: 'EUR' });
      const decision = evaluatePolicy(createValidMandate({ currency: 'USD' }), proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('CURRENCY_NOT_ALLOWED');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-06: Category allowlist & max items
  // --------------------------------------------------------------------------
  describe('Rule P-06: Category Allowlist & Max Items Count', () => {
    it('DENY CATEGORY_NOT_ALLOWED when item category is not in allowed_categories', () => {
      const facts = createValidFacts({
        verifiedItems: [
          { sku: 'SKU-PEN-PACK', name: 'Pen', category: 'weapons_and_ammo', priceMinor: 900 },
        ],
      });
      const decision = evaluatePolicy(createValidMandate(), createValidProposal(), facts, clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('CATEGORY_NOT_ALLOWED');
    });

    it('DENY TOO_MANY_ITEMS when item count exceeds max_items_per_intent', () => {
      const mandate = createValidMandate({ max_items_per_intent: 2 });
      const proposal = createValidProposal({
        items: [
          { sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 300 },
          { sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 300 },
          { sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 300 },
        ],
        claimed_total_minor: 900,
      });
      const decision = evaluatePolicy(mandate, proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('TOO_MANY_ITEMS');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-07: Per-transaction limit & auto-approve threshold
  // --------------------------------------------------------------------------
  describe('Rule P-07: Per-transaction limit & Auto-approve threshold', () => {
    it('DENY OVER_TXN_LIMIT when verified total exceeds per_txn_limit_minor', () => {
      const mandate = createValidMandate({ per_txn_limit_minor: 8000 });
      const facts = createValidFacts({ verifiedTotalMinor: 8500 });
      const proposal = createValidProposal({
        claimed_total_minor: 8500,
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 8500 }],
      });
      facts.verifiedItems[0]!.priceMinor = 8500;

      const decision = evaluatePolicy(mandate, proposal, facts, clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('OVER_TXN_LIMIT');
    });

    it('STEP_UP OVER_AUTO_LIMIT when verified total exceeds auto_approve_limit_minor but is within per_txn_limit_minor', () => {
      const mandate = createValidMandate({ auto_approve_limit_minor: 3000, per_txn_limit_minor: 8000 });
      const facts = createValidFacts({ verifiedTotalMinor: 4500 });
      const proposal = createValidProposal({
        claimed_total_minor: 4500,
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 4500 }],
      });
      facts.verifiedItems[0]!.priceMinor = 4500;

      const decision = evaluatePolicy(mandate, proposal, facts, clockNow);
      expect(decision.verdict).toBe('STEP_UP');
      expect(decision.reason_codes).toContain('OVER_AUTO_LIMIT');
    });

    it('ALLOW when verified total is within auto_approve_limit_minor', () => {
      const mandate = createValidMandate({ auto_approve_limit_minor: 3000 });
      const decision = evaluatePolicy(mandate, createValidProposal(), createValidFacts(), clockNow);
      expect(decision.verdict).toBe('ALLOW');
      expect(decision.reason_codes).toContain('APPROVED');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-08: Budget invariant
  // --------------------------------------------------------------------------
  describe('Rule P-08: Budget Invariant (captured + reserved + verified_total <= total_budget)', () => {
    it('DENY BUDGET_EXCEEDED when committed + verified total exceeds total_budget_minor', () => {
      const mandate = createValidMandate({ total_budget_minor: 20000 });
      // captured 15000 + reserved 4500 + intent 900 = 20400 > 20000
      const facts = createValidFacts({
        capturedMinor: 15000,
        reservedMinor: 4500,
        verifiedTotalMinor: 900,
      });
      const decision = evaluatePolicy(mandate, createValidProposal(), facts, clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('BUDGET_EXCEEDED');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-09: Hourly transaction velocity
  // --------------------------------------------------------------------------
  describe('Rule P-09: Hourly Transaction Velocity Limit', () => {
    it('STEP_UP VELOCITY when recentTxnCount >= max_txns_per_hour', () => {
      const mandate = createValidMandate({ max_txns_per_hour: 3 });
      const facts = createValidFacts({ recentTxnCount: 3 });
      const decision = evaluatePolicy(mandate, createValidProposal(), facts, clockNow);
      expect(decision.verdict).toBe('STEP_UP');
      expect(decision.reason_codes).toContain('VELOCITY');
    });

    it('DENY VELOCITY_LIMIT_EXCEEDED when recentTxnCount >= 2 * max_txns_per_hour', () => {
      const mandate = createValidMandate({ max_txns_per_hour: 3 });
      const facts = createValidFacts({ recentTxnCount: 6 });
      const decision = evaluatePolicy(mandate, createValidProposal(), facts, clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('VELOCITY_LIMIT_EXCEEDED');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-10: Advisory Injection Risk Score
  // --------------------------------------------------------------------------
  describe('Rule P-10: Advisory Injection Risk Score', () => {
    it('DENY RISK_SCORE_HIGH when risk score >= deny_threshold', () => {
      const mandate = createValidMandate({ risk: { step_up_threshold: 40, deny_threshold: 75 } });
      const facts = createValidFacts({ riskResult: { score: 85, signals: ['hidden_text'] } });
      const decision = evaluatePolicy(mandate, createValidProposal(), facts, clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('RISK_SCORE_HIGH');
    });

    it('STEP_UP RISK_SCORE_MEDIUM when risk score >= step_up_threshold but < deny_threshold', () => {
      const mandate = createValidMandate({ risk: { step_up_threshold: 40, deny_threshold: 75 } });
      const facts = createValidFacts({ riskResult: { score: 55, signals: ['instruction_phrase'] } });
      const decision = evaluatePolicy(mandate, createValidProposal(), facts, clockNow);
      expect(decision.verdict).toBe('STEP_UP');
      expect(decision.reason_codes).toContain('RISK_SCORE_MEDIUM');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-11: Provenance & user_goal_ref
  // --------------------------------------------------------------------------
  describe('Rule P-11: Provenance Present & User Goal Ref Valid', () => {
    it('DENY PROVENANCE_MISSING if provenance sources array is empty', () => {
      const proposal = createValidProposal({
        provenance: { sources: [] },
      });
      const decision = evaluatePolicy(createValidMandate(), proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('PROVENANCE_MISSING');
    });

    it('DENY PROVENANCE_MISSING if user_goal_ref is empty', () => {
      const proposal = createValidProposal({
        user_goal_ref: '   ',
      });
      const decision = evaluatePolicy(createValidMandate(), proposal, createValidFacts(), clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('PROVENANCE_MISSING');
    });
  });

  // --------------------------------------------------------------------------
  // Rule P-12: Fallthrough default ALLOW & Precedence
  // --------------------------------------------------------------------------
  describe('Rule P-12: Fallthrough Default ALLOW and Strict Precedence (DENY > STEP_UP > ALLOW)', () => {
    it('ALLOW APPROVED when all rules pass', () => {
      const decision = evaluatePolicy(createValidMandate(), createValidProposal(), createValidFacts(), clockNow);
      expect(decision.verdict).toBe('ALLOW');
      expect(decision.reason_codes).toContain('APPROVED');
      expect(decision.policy_trace.find((t) => t.rule === 'P-12')?.result).toBe('pass');
    });

    it('Strict Precedence: DENY overrides STEP_UP when multiple rules trigger', () => {
      // P-07 triggers STEP_UP (4500 cents > 3000 cents auto_approve)
      // P-03 triggers DENY (merchant not allowed)
      const mandate = createValidMandate({
        auto_approve_limit_minor: 3000,
        per_txn_limit_minor: 8000,
        allowed_merchants: ['mrc_allowed_only'],
      });
      const facts = createValidFacts({ verifiedTotalMinor: 4500 });
      facts.verifiedItems[0]!.priceMinor = 4500;
      const proposal = createValidProposal({
        merchant_ref: 'mrc_other_merchant',
        claimed_total_minor: 4500,
        items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: 4500 }],
      });

      const decision = evaluatePolicy(mandate, proposal, facts, clockNow);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason_codes).toContain('MERCHANT_NOT_ALLOWED');
      expect(decision.reason_codes).toContain('OVER_AUTO_LIMIT');
      // Final verdict must strictly be DENY per FR-11
      expect(decision.verdict).not.toBe('STEP_UP');
    });
  });

  // --------------------------------------------------------------------------
  // Property-based Tests (Permutations, Monotonicity, Key Injection)
  // --------------------------------------------------------------------------
  describe('Property-based Invariants (T-009 Definition of Done)', () => {
    it('Property 1: Permuting items array order NEVER alters the final verdict or verified total', () => {
      const itemA = { sku: 'SKU-PEN', name: 'Pen', category: 'office_supplies', priceMinor: 400 };
      const itemB = { sku: 'SKU-BOOK', name: 'Book', category: 'books', priceMinor: 1200 };
      const itemC = { sku: 'SKU-NOTE', name: 'Notebook', category: 'office_supplies', priceMinor: 800 };

      const allItems = [itemA, itemB, itemC];
      const verifiedTotal = 400 + 1200 + 800; // 2400

      // Compute all 3! = 6 permutations
      function permute<T>(arr: T[]): T[][] {
        if (arr.length <= 1) return [arr];
        const result: T[][] = [];
        for (let i = 0; i < arr.length; i++) {
          const current = arr[i]!;
          const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
          for (const p of permute(rest)) {
            result.push([current, ...p]);
          }
        }
        return result;
      }

      const permutations = permute(allItems);
      expect(permutations).toHaveLength(6);

      const verdicts = new Set<string>();
      const totals = new Set<number | null>();

      for (const pItems of permutations) {
        const proposal: PurchaseIntentProposal = {
          intent_id: 'int_perm_test',
          mandate_id: 'mnd_test_policy_001',
          merchant_ref: 'mrc_demo_store',
          items: pItems.map((it) => ({
            sku: it.sku,
            qty: 1,
            claimed_unit_price_minor: it.priceMinor,
          })),
          claimed_total_minor: verifiedTotal,
          currency: 'USD',
          user_goal_ref: 'msg_perm_goal',
          rationale: 'Permutation test items',
          provenance: {
            sources: [{ kind: 'user', ref: 'msg_perm_goal', trust: 'user' }],
          },
        };

        const facts: PolicyEvaluationFacts = {
          verifiedItems: pItems,
          verifiedTotalMinor: verifiedTotal,
          capturedMinor: 0,
          reservedMinor: 0,
        };

        const decision = evaluatePolicy(createValidMandate(), proposal, facts, clockNow);
        verdicts.add(decision.verdict);
        totals.add(decision.verified_total_minor);
      }

      // Exactly 1 verdict (ALLOW) and exactly 1 verified total across all permutations!
      expect(verdicts.size).toBe(1);
      expect(verdicts.has('ALLOW')).toBe(true);
      expect(totals.size).toBe(1);
      expect(totals.has(verifiedTotal)).toBe(true);
    });

    it('Property 2: Amount Monotonicity — any verified amount exceeding per_txn_limit NEVER yields ALLOW', () => {
      const perTxnLimit = 8000;
      const mandate = createValidMandate({ per_txn_limit_minor: perTxnLimit, total_budget_minor: 1000000 });

      // Test a wide spectrum of amounts strictly greater than per_txn_limit
      const amountsOverLimit = [
        perTxnLimit + 1,
        perTxnLimit + 50,
        perTxnLimit + 500,
        perTxnLimit + 5000,
        perTxnLimit * 2,
        perTxnLimit * 5,
        perTxnLimit * 10,
      ];

      for (const amount of amountsOverLimit) {
        const proposal: PurchaseIntentProposal = {
          intent_id: `int_mono_${amount}`,
          mandate_id: 'mnd_test_policy_001',
          merchant_ref: 'mrc_demo_store',
          items: [{ sku: 'SKU-PEN-PACK', qty: 1, claimed_unit_price_minor: amount }],
          claimed_total_minor: amount,
          currency: 'USD',
          user_goal_ref: 'msg_mono',
          rationale: 'Monotonicity check',
          provenance: { sources: [{ kind: 'user', ref: 'msg_mono', trust: 'user' }] },
        };

        const facts: PolicyEvaluationFacts = {
          verifiedItems: [{ sku: 'SKU-PEN-PACK', name: 'Pen', category: 'office_supplies', priceMinor: amount }],
          verifiedTotalMinor: amount,
          capturedMinor: 0,
          reservedMinor: 0,
        };

        const decision = evaluatePolicy(mandate, proposal, facts, clockNow);
        // INVARIANT: Verdict can NEVER be ALLOW when exceeding per_txn_limit
        expect(decision.verdict).toBe('DENY');
        expect(decision.reason_codes).toContain('OVER_TXN_LIMIT');
      }
    });

    it('Property 3: Payee Key Injection at ANY nested depth ALWAYS yields DENY', () => {
      const forbiddenKeyNames = [
        'recipient',
        'payee',
        'payee_email',
        'destination',
        'wallet_address',
        'iban',
        'account_number',
        '__proto__',
      ];

      // Helper to build object with forbidden key at specified nested depth
      function buildNestedObject(depth: number, key: string, value: unknown): Record<string, unknown> {
        if (depth <= 1) {
          return { [key]: value };
        }
        return { nested: buildNestedObject(depth - 1, key, value) };
      }

      // Test depths from 1 through 10
      for (const depth of [1, 2, 3, 5, 8, 10]) {
        for (const forbiddenKey of forbiddenKeyNames) {
          const rawPayload = {
            ...createValidProposal(),
            injection: buildNestedObject(depth, forbiddenKey, 'attacker_controlled_value'),
          };

          const decision = evaluatePolicy(
            createValidMandate(),
            createValidProposal(),
            createValidFacts(),
            clockNow,
            { rawJson: JSON.stringify(rawPayload) },
          );

          // INVARIANT: Payee key injection at any depth MUST be blocked with DENY
          expect(decision.verdict).toBe('DENY');
          expect(decision.reason_codes).toContain('PAYEE_OVERRIDE_ATTEMPT');
        }
      }
    });
  });

  describe('evaluatePolicyRules named parameter wrapper', () => {
    it('works identically to evaluatePolicy with named parameters', () => {
      const decision = evaluatePolicyRules({
        mandate: createValidMandate(),
        proposal: createValidProposal(),
        facts: createValidFacts(),
        now: clockNow,
        hmacKey: TEST_HMAC_KEY,
      });
      expect(decision.verdict).toBe('ALLOW');
      expect(decision.reason_codes).toContain('APPROVED');
    });
  });
});
