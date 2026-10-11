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

