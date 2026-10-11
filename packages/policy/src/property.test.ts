import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateFullPolicy, type PolicyEvaluationFacts } from './engine.js';
import type { Mandate, PurchaseIntentProposal } from '@mandatepay/schemas';

describe('Policy Engine Property-Based Testing with fast-check (INV-8, FR-26)', () => {
  it('Property: For ANY arbitrary sequence of intents and budgets, (captured + reserved) NEVER exceeds total_budget', () => {
    fc.assert(
      fc.property(
        // Arbitrary total budget between $1.00 and $1,000.00
        fc.integer({ min: 100, max: 100000 }),
        // Arbitrary per_txn_limit between $0.50 and total_budget
        fc.integer({ min: 50, max: 50000 }),
        // Arbitrary sequence of 1 to 50 intent item quantities & prices
        fc.array(
          fc.record({
            priceMinor: fc.integer({ min: 10, max: 10000 }),
            qty: fc.integer({ min: 1, max: 10 }),
            intentId: fc.stringMatching(/^[a-zA-Z0-9_]{5,15}$/),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (totalBudget, perTxnLimit, intentSeries) => {
          const effectivePerTxn = Math.min(perTxnLimit, totalBudget);

          const mandate: Mandate = {
            mandate_id: 'mnd_property_test',
            owner_id: 'usr_owner',
            agent_id: 'agt_shopper',
            currency: 'USD',
            valid_from: '2026-10-01T00:00:00Z',
            valid_until: '2026-10-31T23:59:59Z',
            total_budget_minor: totalBudget,
            per_txn_limit_minor: effectivePerTxn,
            auto_approve_limit_minor: Math.floor(effectivePerTxn / 2),
            max_txns_per_hour: 1000,
            allowed_merchants: ['mrc_prop_store'],
            allowed_categories: ['supplies'],
            max_items_per_intent: 20,
            max_pending_approvals: 100,
            suspend_after_denies: 1000,
            step_up: { channel: 'dashboard', timeout_seconds: 300 },
            risk: { step_up_threshold: 50, deny_threshold: 80 },
            wallet: { type: 'paypal_vault', ref: 'tok_wallet' },
            status: 'ACTIVE',
            version: 1,
            created_at: '2026-10-01T00:00:00Z',
            signature: 'sig_property_test_valid',
          };

          let capturedMinor = 0;
          let reservedMinor = 0;

          for (const item of intentSeries) {
            const itemCost = item.priceMinor * item.qty;
            const proposal: PurchaseIntentProposal = {
              intent_id: `int_${item.intentId}`,
              mandate_id: mandate.mandate_id,
              merchant_ref: 'mrc_prop_store',
              items: [
                {
                  sku: 'SKU-PROP',
                  qty: item.qty,
                  claimed_unit_price_minor: item.priceMinor,
                },
              ],
              claimed_total_minor: itemCost,
              currency: 'USD',
              user_goal_ref: 'goal_prop',
              rationale: 'Property test intent',
              provenance: {
                sources: [{ kind: 'web', ref: 'ref_store', trust: 'untrusted_web' }],
              },
            };

            const facts: PolicyEvaluationFacts = {
              verifiedItems: [
                {
                  sku: 'SKU-PROP',
                  name: 'Property Test Item',
                  category: 'supplies',
                  priceMinor: item.priceMinor,
                },
              ],
              verifiedTotalMinor: itemCost,
              capturedMinor,
              reservedMinor,
            };

            const decision = evaluateFullPolicy(
              mandate,
              proposal,
              facts,
              '2026-10-15T12:00:00Z',
            );

            if (decision.verdict === 'ALLOW') {
              // Successfully allowed within limits and budget
              expect(capturedMinor + reservedMinor + itemCost).toBeLessThanOrEqual(totalBudget);
              expect(itemCost).toBeLessThanOrEqual(effectivePerTxn);
              // Transition reservation to capture
              capturedMinor += itemCost;
            } else if (decision.verdict === 'STEP_UP') {
              // Stepped up within limits and budget
              expect(capturedMinor + reservedMinor + itemCost).toBeLessThanOrEqual(totalBudget);
              expect(itemCost).toBeLessThanOrEqual(effectivePerTxn);
              // Held in reservation
              reservedMinor += itemCost;
            } else {
              // Denied: could be over per_txn or over budget
              expect(decision.verdict).toBe('DENY');
              expect(decision.reason_codes.length).toBeGreaterThan(0);
              const expectedDeny =
                itemCost > effectivePerTxn ||
                capturedMinor + reservedMinor + itemCost > totalBudget;
              expect(expectedDeny).toBe(true);
            }

            // CRITICAL INVARIANT (INV-8, AC-8):
            // (captured + reserved) MUST NEVER EXCEED total_budget at any point in time!
            expect(capturedMinor + reservedMinor).toBeLessThanOrEqual(totalBudget);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
