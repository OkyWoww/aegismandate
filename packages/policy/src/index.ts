import type {
  Mandate,
  PurchaseIntent,
  PolicyDecision,
  PurchaseIntentProposal,
  Decision,
} from '@mandatepay/schemas';
import {
  evaluateFullPolicy,
  type PolicyEvaluationFacts,
  type EvaluatePolicyOptions,
} from './engine.js';

export interface PolicyEvaluationContext {
  mandate: Mandate;
  intent: PurchaseIntent;
  cumulativeSpendToDate: number;
  evaluatedAt?: string | undefined;
}

/**
 * Pure, deterministic evaluation of a purchase intent against an active mandate.
 * Overloaded for both:
 * 1. Full 13-rule Policy Engine (spec.md §4, FR-8): evaluatePolicy(mandate, intent, facts, now, options)
 * 2. Legacy context evaluation for early bootstrap tests: evaluatePolicy(context)
 */
export function evaluatePolicy(context: PolicyEvaluationContext): PolicyDecision;
export function evaluatePolicy(
  mandate: Mandate | null | undefined,
  proposal: PurchaseIntentProposal,
  facts: PolicyEvaluationFacts,
  now: string,
  options?: EvaluatePolicyOptions | undefined,
): Decision;
export function evaluatePolicy(
  arg1: Mandate | null | undefined | PolicyEvaluationContext,
  arg2?: PurchaseIntentProposal,
  arg3?: PolicyEvaluationFacts,
  arg4?: string,
  arg5?: EvaluatePolicyOptions,
): Decision | PolicyDecision {
  if (arg1 && typeof arg1 === 'object' && 'intent' in arg1 && 'cumulativeSpendToDate' in arg1) {
    return evaluateLegacyPolicy(arg1 as PolicyEvaluationContext);
  }
  return evaluateFullPolicy(
    arg1 as Mandate | null | undefined,
    arg2 as PurchaseIntentProposal,
    arg3 as PolicyEvaluationFacts,
    arg4 as string,
    arg5,
  );
}

function evaluateLegacyPolicy(context: PolicyEvaluationContext): PolicyDecision {
  const { mandate, intent, cumulativeSpendToDate } = context;
  const now = context.evaluatedAt ?? new Date().toISOString();

  // 1. Check expiration
  if (new Date(now).getTime() > new Date(mandate.valid_until).getTime()) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.mandate_id,
      reasonCode: 'MANDATE_EXPIRED',
      details: `Mandate expired at ${mandate.valid_until}`,
      evaluatedAt: now,
    };
  }

  // 2. Check currency matching
  if (intent.currency !== mandate.currency) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.mandate_id,
      reasonCode: 'CURRENCY_MISMATCH',
      details: `Requested currency ${intent.currency} does not match mandate currency ${mandate.currency}`,
      evaluatedAt: now,
    };
  }

  // 3. Merchant allowed check
  const isMerchantAllowed = mandate.allowed_merchants.some((allowed: string) =>
    intent.merchantDomain.toLowerCase().endsWith(allowed.toLowerCase()),
  );
  if (!isMerchantAllowed) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.mandate_id,
      reasonCode: 'MERCHANT_NOT_ALLOWED',
      details: `Merchant domain ${intent.merchantDomain} is not in allowed merchants`,
      evaluatedAt: now,
    };
  }

  // 4. Single-item cap check & category check
  for (const item of intent.items) {
    const itemPriceMinor = Math.round(item.unitPrice * 100);
    if (itemPriceMinor > mandate.per_txn_limit_minor) {
      return {
        approved: false,
        intentId: intent.id,
        mandateId: mandate.mandate_id,
        reasonCode: 'ITEM_CAP_EXCEEDED',
        details: `Item "${item.name}" price exceeds per_txn_limit_minor`,
        evaluatedAt: now,
      };
    }

    if (
      item.category &&
      mandate.allowed_categories.length > 0 &&
      !mandate.allowed_categories.includes(item.category)
    ) {
      return {
        approved: false,
        intentId: intent.id,
        mandateId: mandate.mandate_id,
        reasonCode: 'CATEGORY_FORBIDDEN',
        details: `Category "${item.category}" is not in allowed categories`,
        evaluatedAt: now,
      };
    }
  }

  // 5. Total budget check
  const intentTotalMinor = Math.round(intent.totalAmount * 100);
  if (cumulativeSpendToDate + intentTotalMinor > mandate.total_budget_minor) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.mandate_id,
      reasonCode: 'BUDGET_EXCEEDED',
      details: `Total spend exceeds mandate total_budget_minor ${mandate.total_budget_minor}`,
      evaluatedAt: now,
    };
  }

  // All deterministic checks passed
  return {
    approved: true,
    intentId: intent.id,
    mandateId: mandate.mandate_id,
    reasonCode: 'APPROVED',
    details: 'Policy evaluation passed all safety constraints',
    evaluatedAt: now,
  };
}

export * from './mandate.js';
export {
  evaluatePolicyRules,
  evaluateFullPolicy,
  POLICY_ENGINE_VERSION,
  type VerifiedItemFact,
  type PolicyEvaluationFacts,
  type EvaluatePolicyOptions,
  type EvaluatePolicyParams,
} from './engine.js';
