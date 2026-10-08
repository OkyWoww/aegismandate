import type { Mandate, PurchaseIntent, PolicyDecision } from '@mandatepay/schemas';

export interface PolicyEvaluationContext {
  mandate: Mandate;
  intent: PurchaseIntent;
  cumulativeSpendToDate: number;
  evaluatedAt?: string;
}

/**
 * Pure, deterministic evaluation of a purchase intent against an active mandate.
 * Absolutely zero I/O or network requests.
 */
export function evaluatePolicy(context: PolicyEvaluationContext): PolicyDecision {
  const { mandate, intent, cumulativeSpendToDate } = context;
  const now = context.evaluatedAt ?? new Date().toISOString();

  // 1. Check expiration
  if (new Date(now).getTime() > new Date(mandate.expiresAt).getTime()) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.id,
      reasonCode: 'MANDATE_EXPIRED',
      details: `Mandate expired at ${mandate.expiresAt}`,
      evaluatedAt: now,
    };
  }

  // 2. Check currency matching
  if (intent.currency !== mandate.scope.currency) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.id,
      reasonCode: 'CURRENCY_MISMATCH',
      details: `Requested currency ${intent.currency} does not match mandate currency ${mandate.scope.currency}`,
      evaluatedAt: now,
    };
  }

  // 3. Merchant whitelist check
  const isMerchantAllowed = mandate.scope.merchantWhitelist.some((allowed: string) =>
    intent.merchantDomain.toLowerCase().endsWith(allowed.toLowerCase())
  );
  if (!isMerchantAllowed) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.id,
      reasonCode: 'MERCHANT_NOT_ALLOWED',
      details: `Merchant domain ${intent.merchantDomain} is not in authorized whitelist`,
      evaluatedAt: now,
    };
  }

  // 4. Single-item cap check & forbidden category check
  for (const item of intent.items) {
    if (item.unitPrice > mandate.scope.maxPerItem) {
      return {
        approved: false,
        intentId: intent.id,
        mandateId: mandate.id,
        reasonCode: 'ITEM_CAP_EXCEEDED',
        details: `Item "${item.name}" unit price $${item.unitPrice} exceeds maxPerItem cap $${mandate.scope.maxPerItem}`,
        evaluatedAt: now,
      };
    }

    if (item.category && mandate.scope.forbiddenCategories.includes(item.category)) {
      return {
        approved: false,
        intentId: intent.id,
        mandateId: mandate.id,
        reasonCode: 'CATEGORY_FORBIDDEN',
        details: `Category "${item.category}" is explicitly forbidden by mandate`,
        evaluatedAt: now,
      };
    }
  }

  // 5. Total budget check
  if (cumulativeSpendToDate + intent.totalAmount > mandate.scope.maxTotalBudget) {
    return {
      approved: false,
      intentId: intent.id,
      mandateId: mandate.id,
      reasonCode: 'BUDGET_EXCEEDED',
      details: `Total spend ($${cumulativeSpendToDate} + $${intent.totalAmount}) exceeds maximum mandate budget $${mandate.scope.maxTotalBudget}`,
      evaluatedAt: now,
    };
  }

  // All deterministic checks passed
  return {
    approved: true,
    intentId: intent.id,
    mandateId: mandate.id,
    reasonCode: 'APPROVED',
    details: 'Policy evaluation passed all safety constraints',
    evaluatedAt: now,
  };
}
