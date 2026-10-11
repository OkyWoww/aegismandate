import { randomUUID } from 'node:crypto';
import type {
  Mandate,
  PurchaseIntentProposal,
  Decision,
  DecisionVerdict,
  PolicyTraceItem,
} from '@mandatepay/schemas';
import { DecisionSchema, deepKeyScan } from '@mandatepay/schemas';
import { checkMandateUsable } from './mandate.js';

export interface VerifiedItemFact {
  sku: string;
  name: string;
  category: string;
  priceMinor: number;
}

export interface PolicyEvaluationFacts {
  verifiedItems: VerifiedItemFact[];
  verifiedTotalMinor: number;
  capturedMinor: number;
  reservedMinor: number;
  pendingApprovals?: number;
  recentTxnCount?: number;
  riskResult?: { score: number; signals: string[] };
}

export interface EvaluatePolicyParams {
  mandate: Mandate;
  proposal: PurchaseIntentProposal;
  rawJson?: string | undefined;
  facts: PolicyEvaluationFacts;
  now: string;
  hmacKey: string;
}

export const POLICY_ENGINE_VERSION = '0.1.0';

/**
 * Pure, deterministic Policy Engine implementing P-00 through P-12 (spec.md §4).
 * Absolutely ZERO I/O or network requests.
 * Evaluates all applicable rules, builds ordered policy trace, applies precedence:
 * DENY > STEP_UP > ALLOW
 */
export function evaluatePolicyRules(params: EvaluatePolicyParams): Decision {
  const { mandate, proposal, rawJson, facts, now, hmacKey } = params;

  const trace: PolicyTraceItem[] = [];
  const reasonCodes: string[] = [];
  const state: { verdict: DecisionVerdict } = { verdict: 'ALLOW' };

  const addDeny = (rule: string, code: string, detail?: string) => {
    trace.push({ rule, result: 'deny', detail });
    reasonCodes.push(code);
    state.verdict = 'DENY';
  };

  const addStepUp = (rule: string, code: string, detail?: string) => {
    trace.push({ rule, result: 'step_up', detail });
    reasonCodes.push(code);
    if (state.verdict !== 'DENY') {
      state.verdict = 'STEP_UP';
    }
  };

  const addPass = (rule: string, detail?: string) => {
    trace.push({ rule, result: 'pass', detail });
  };

  // --------------------------------------------------------------------------
  // Rule P-00: Mandate exists, signature valid, status=ACTIVE, now ∈ [valid_from, valid_until]
  // --------------------------------------------------------------------------
  const usableCheck = checkMandateUsable(mandate, hmacKey, now);
  if (!usableCheck.usable) {
    addDeny('P-00', usableCheck.reasonCode ?? 'MANDATE_INVALID', usableCheck.details);
  } else {
    // Valid from check
    const fromTime = new Date(mandate.valid_from).getTime();
    const nowTime = new Date(now).getTime();
    if (nowTime < fromTime) {
      addDeny('P-00', 'MANDATE_NOT_YET_VALID', `Mandate valid_from is ${mandate.valid_from}`);
    } else {
      addPass('P-00');
    }
  }

  // --------------------------------------------------------------------------
  // Rule P-03: Deep key scan & Payee Allowlist
  // --------------------------------------------------------------------------
  const toScan = rawJson ? JSON.parse(rawJson) : proposal;
  const scanResult = deepKeyScan(toScan);
  if (scanResult.hasForbiddenKey || scanResult.hasForbiddenValue) {
    const firstViolation = scanResult.violations[0];
    addDeny(
      'P-03',
      'PAYEE_OVERRIDE_ATTEMPT',
      firstViolation ? `${firstViolation.type} at ${firstViolation.path}: ${firstViolation.detail}` : 'Forbidden payee key or value detected',
    );
  } else if (!mandate.allowed_merchants.includes(proposal.merchant_ref)) {
    addDeny(
      'P-03',
      'MERCHANT_NOT_ALLOWED',
      `Merchant '${proposal.merchant_ref}' not in allowed_merchants`,
    );
  } else {
    addPass('P-03');
  }

  // --------------------------------------------------------------------------
  // Rule P-04: Server-verified price × qty = verified_total
  // --------------------------------------------------------------------------
  let skuMismatch = false;
  for (const item of proposal.items) {
    const verified = facts.verifiedItems.find((v) => v.sku === item.sku);
    if (!verified) {
      addDeny('P-04', 'UNKNOWN_SKU', `SKU '${item.sku}' not found in merchant catalog`);
      skuMismatch = true;
      break;
    }
    if (verified.priceMinor !== item.claimed_unit_price_minor) {
      addDeny(
        'P-04',
        'PRICE_MISMATCH',
        `Claimed unit price ${item.claimed_unit_price_minor} != server price ${verified.priceMinor} for ${item.sku}`,
      );
      skuMismatch = true;
      break;
    }
  }

  if (!skuMismatch) {
    if (facts.verifiedTotalMinor !== proposal.claimed_total_minor) {
      addDeny(
        'P-04',
        'PRICE_MISMATCH',
        `Claimed total ${proposal.claimed_total_minor} != server verified total ${facts.verifiedTotalMinor}`,
      );
    } else {
      addPass('P-04', `verified_total: ${facts.verifiedTotalMinor}`);
    }
  }

  // --------------------------------------------------------------------------
  // Rule P-05: Currency matching
  // --------------------------------------------------------------------------
  if (proposal.currency !== mandate.currency) {
    addDeny(
      'P-05',
      'CURRENCY_MISMATCH',
      `Requested ${proposal.currency} != mandate ${mandate.currency}`,
    );
  } else {
    addPass('P-05');
  }

  // --------------------------------------------------------------------------
  // Rule P-06: Category whitelist & Max items per intent
  // --------------------------------------------------------------------------
  let categoryForbidden = false;
  if (mandate.allowed_categories.length > 0) {
    for (const item of facts.verifiedItems) {
      if (!mandate.allowed_categories.includes(item.category)) {
        addDeny(
          'P-06',
          'CATEGORY_FORBIDDEN',
          `Category '${item.category}' not in allowed_categories`,
        );
        categoryForbidden = true;
        break;
      }
    }
  }

  if (!categoryForbidden) {
    if (proposal.items.length > mandate.max_items_per_intent) {
      addDeny(
        'P-06',
        'TOO_MANY_ITEMS',
        `Item count ${proposal.items.length} > max_items_per_intent ${mandate.max_items_per_intent}`,
      );
    } else {
      addPass('P-06');
    }
  }

  // --------------------------------------------------------------------------
  // Rule P-07: Per-transaction limit & Auto-approve threshold
  // --------------------------------------------------------------------------
  if (facts.verifiedTotalMinor > mandate.per_txn_limit_minor) {
    addDeny(
      'P-07',
      'OVER_TXN_LIMIT',
      `Total ${facts.verifiedTotalMinor} > per_txn_limit ${mandate.per_txn_limit_minor}`,
    );
  } else if (facts.verifiedTotalMinor > mandate.auto_approve_limit_minor) {
    addStepUp(
      'P-07',
      'OVER_AUTO_LIMIT',
      `Total ${facts.verifiedTotalMinor} > auto_approve_limit ${mandate.auto_approve_limit_minor}`,
    );
  } else {
    addPass('P-07', 'within_auto_approve_limit');
  }

  // --------------------------------------------------------------------------
  // Rule P-08: Budget invariant (captured + reserved + verified_total <= total_budget)
  // --------------------------------------------------------------------------
  const committed = facts.capturedMinor + facts.reservedMinor;
  if (committed + facts.verifiedTotalMinor > mandate.total_budget_minor) {
    addDeny(
      'P-08',
      'BUDGET_EXCEEDED',
      `Total spend ${committed + facts.verifiedTotalMinor} > budget ${mandate.total_budget_minor}`,
    );
  } else {
    addPass('P-08', `remaining_budget: ${mandate.total_budget_minor - committed}`);
  }

  // --------------------------------------------------------------------------
  // Rule P-10: Advisory Injection Risk Score (if supplied)
  // --------------------------------------------------------------------------
  if (facts.riskResult) {
    if (facts.riskResult.score >= mandate.risk.deny_threshold) {
      addDeny(
        'P-10',
        'RISK_SCORE_HIGH',
        `Advisory risk score ${facts.riskResult.score} >= deny_threshold ${mandate.risk.deny_threshold}`,
      );
    } else if (facts.riskResult.score >= mandate.risk.step_up_threshold) {
      addStepUp(
        'P-10',
        'RISK_SCORE_MEDIUM',
        `Advisory risk score ${facts.riskResult.score} >= step_up_threshold ${mandate.risk.step_up_threshold}`,
      );
    } else {
      addPass('P-10');
    }
  }

  // Default ALLOW reason
  if (state.verdict === 'ALLOW') {
    reasonCodes.push('APPROVED');
    addPass('P-12', 'all_rules_passed');
  }

  const decisionId = `dec_${randomUUID().replace(/-/g, '')}`;
  const decision: Decision = {
    decision_id: decisionId,
    intent_id: proposal.intent_id,
    verdict: state.verdict,
    reason_codes: reasonCodes,
    risk: {
      score: facts.riskResult?.score ?? 0,
      signals: facts.riskResult?.signals ?? [],
    },
    policy_trace: trace,
    verified_total_minor: state.verdict !== 'DENY' ? facts.verifiedTotalMinor : null,
    decided_at: now,
    engine_version: POLICY_ENGINE_VERSION,
  };

  return DecisionSchema.parse(decision);
}
