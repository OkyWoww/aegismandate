import { randomUUID } from 'node:crypto';
import type {
  Mandate,
  PurchaseIntentProposal,
  Decision,
  DecisionVerdict,
  PolicyTraceItem,
} from '@mandatepay/schemas';
import {
  DecisionSchema,
  PurchaseIntentProposalSchema,
  deepKeyScan,
} from '@mandatepay/schemas';
import { checkMandateUsable, isMandateExpired } from './mandate.js';

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
  pendingApprovals?: number | undefined;
  recentTxnCount?: number | undefined;
  riskResult?: { score: number; signals: string[] } | undefined;
  storedDecision?: Decision | undefined;
}

export interface EvaluatePolicyOptions {
  hmacKey?: string | undefined;
  rawJson?: string | undefined;
}

export interface EvaluatePolicyParams {
  mandate: Mandate | null | undefined;
  proposal: PurchaseIntentProposal;
  rawJson?: string | undefined;
  facts: PolicyEvaluationFacts;
  now: string;
  hmacKey?: string | undefined;
}

export const POLICY_ENGINE_VERSION = '0.1.0';

/**
 * Pure, deterministic Policy Engine implementing P-00 through P-12 (spec.md §4, FR-8, FR-9, FR-11, INV-5).
 * Absolutely ZERO I/O or network requests.
 * Evaluates all applicable rules in order, builds ordered policy trace, applies precedence:
 * DENY > STEP_UP > ALLOW
 */
export function evaluateFullPolicy(
  mandate: Mandate | null | undefined,
  proposal: PurchaseIntentProposal,
  facts: PolicyEvaluationFacts,
  now: string,
  options: EvaluatePolicyOptions = {},
): Decision {
  const { hmacKey, rawJson } = options;

  // --------------------------------------------------------------------------
  // Rule P-02: Idempotency check (Unseen intent_id)
  // If a decision was already stored for this intent_id, return it immediately.
  // --------------------------------------------------------------------------
  if (facts.storedDecision && facts.storedDecision.intent_id === proposal.intent_id) {
    return facts.storedDecision;
  }

  const trace: PolicyTraceItem[] = [];
  const reasonCodes: string[] = [];
  const state: { verdict: DecisionVerdict } = { verdict: 'ALLOW' };

  const addDeny = (rule: string, code: string, detail?: string) => {
    trace.push({ rule, result: 'deny', detail });
    reasonCodes.push(code);
    state.verdict = 'DENY';
  };

  const addStepUp = (rule: string, code: string, detail?: string) => {
    // FR-27: At most max_pending_approvals STEP_UP intents may be pending; further ones -> DENY APPROVAL_QUEUE_FULL
    if (
      mandate &&
      facts.pendingApprovals !== undefined &&
      facts.pendingApprovals >= mandate.max_pending_approvals
    ) {
      addDeny(
        rule,
        'APPROVAL_QUEUE_FULL',
        `Pending approvals count ${facts.pendingApprovals} >= max_pending_approvals ${mandate.max_pending_approvals}`,
      );
      return;
    }
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
  if (!mandate) {
    addDeny('P-00', 'MANDATE_NOT_FOUND', 'Mandate does not exist');
  } else if (hmacKey) {
    const usableCheck = checkMandateUsable(mandate, hmacKey, now);
    if (!usableCheck.usable) {
      const code =
        usableCheck.reasonCode === 'INVALID_SIGNATURE'
          ? 'MANDATE_INVALID'
          : usableCheck.reasonCode ?? 'MANDATE_INVALID';
      addDeny('P-00', code, usableCheck.details);
    } else {
      const fromTime = new Date(mandate.valid_from).getTime();
      const nowTime = new Date(now).getTime();
      if (nowTime < fromTime) {
        addDeny('P-00', 'MANDATE_NOT_YET_VALID', `Mandate valid_from is ${mandate.valid_from}`);
      } else {
        addPass('P-00');
      }
    }
  } else {
    if (mandate.status === 'REVOKED') {
      addDeny('P-00', 'MANDATE_REVOKED', 'Mandate is revoked');
    } else if (mandate.status === 'EXPIRED' || isMandateExpired(mandate, now)) {
      addDeny('P-00', 'MANDATE_EXPIRED', `Mandate expired at ${mandate.valid_until}`);
    } else if (mandate.status !== 'ACTIVE') {
      addDeny('P-00', 'MANDATE_INVALID', `Mandate status is ${mandate.status}`);
    } else {
      const fromTime = new Date(mandate.valid_from).getTime();
      const nowTime = new Date(now).getTime();
      if (nowTime < fromTime) {
        addDeny('P-00', 'MANDATE_NOT_YET_VALID', `Mandate valid_from is ${mandate.valid_from}`);
      } else {
        addPass('P-00');
      }
    }
  }

  // --------------------------------------------------------------------------
  // Rule P-01: Proposal passes strict schema validation
  // --------------------------------------------------------------------------
  const parsedProposal = PurchaseIntentProposalSchema.safeParse(proposal);
  if (!parsedProposal.success) {
    addDeny('P-01', 'MALFORMED', parsedProposal.error.message);
  } else {
    addPass('P-01');
  }

  // P-02 trace entry (idempotency passed)
  addPass('P-02', 'unseen_intent_id');

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
      firstViolation
        ? `${firstViolation.type} at ${firstViolation.path}: ${firstViolation.detail}`
        : 'Forbidden payee key or value detected',
    );
  } else if (mandate && !mandate.allowed_merchants.includes(proposal.merchant_ref)) {
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
  let computedVerifiedTotal = 0;
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
    computedVerifiedTotal += verified.priceMinor * item.qty;
  }

  if (!skuMismatch) {
    if (
      facts.verifiedTotalMinor !== proposal.claimed_total_minor ||
      computedVerifiedTotal !== proposal.claimed_total_minor
    ) {
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
  // Rule P-05: Currency matching mandate
  // --------------------------------------------------------------------------
  if (mandate && proposal.currency !== mandate.currency) {
    addDeny(
      'P-05',
      'CURRENCY_NOT_ALLOWED',
      `Requested ${proposal.currency} != mandate ${mandate.currency}`,
    );
  } else {
    addPass('P-05');
  }

  // --------------------------------------------------------------------------
  // Rule P-06: Category allowlist & Max items count
  // --------------------------------------------------------------------------
  let categoryForbidden = false;
  if (mandate && mandate.allowed_categories.length > 0) {
    for (const item of facts.verifiedItems) {
      if (!mandate.allowed_categories.includes(item.category)) {
        addDeny(
          'P-06',
          'CATEGORY_NOT_ALLOWED',
          `Category '${item.category}' not in allowed_categories`,
        );
        categoryForbidden = true;
        break;
      }
    }
  }

  if (!categoryForbidden) {
    if (mandate && proposal.items.length > mandate.max_items_per_intent) {
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
  if (mandate) {
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
  }

  // --------------------------------------------------------------------------
  // Rule P-08: Budget invariant (captured + reserved + verified_total <= total_budget)
  // --------------------------------------------------------------------------
  if (mandate) {
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
  }

  // --------------------------------------------------------------------------
  // Rule P-09: Hourly transaction velocity limits
  // --------------------------------------------------------------------------
  if (mandate && mandate.max_txns_per_hour !== undefined && facts.recentTxnCount !== undefined) {
    if (facts.recentTxnCount >= 2 * mandate.max_txns_per_hour) {
      addDeny(
        'P-09',
        'VELOCITY_LIMIT_EXCEEDED',
        `Recent transactions count ${facts.recentTxnCount} >= 2x max_txns_per_hour ${mandate.max_txns_per_hour}`,
      );
    } else if (facts.recentTxnCount >= mandate.max_txns_per_hour) {
      addStepUp(
        'P-09',
        'VELOCITY',
        `Recent transactions count ${facts.recentTxnCount} >= max_txns_per_hour ${mandate.max_txns_per_hour}`,
      );
    } else {
      addPass('P-09', `recent_txns: ${facts.recentTxnCount}`);
    }
  } else {
    addPass('P-09');
  }

  // --------------------------------------------------------------------------
  // Rule P-10: Advisory Injection Risk Score (if supplied)
  // --------------------------------------------------------------------------
  if (facts.riskResult && mandate) {
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
  } else {
    addPass('P-10');
  }

  // --------------------------------------------------------------------------
  // Rule P-11: Provenance present & user_goal_ref valid
  // --------------------------------------------------------------------------
  const hasProvenanceSources =
    proposal.provenance &&
    Array.isArray(proposal.provenance.sources) &&
    proposal.provenance.sources.length > 0;
  const hasUserGoalRef =
    typeof proposal.user_goal_ref === 'string' &&
    proposal.user_goal_ref.trim().length > 0;

  if (!hasProvenanceSources || !hasUserGoalRef) {
    addDeny(
      'P-11',
      'PROVENANCE_MISSING',
      'Proposal missing required provenance sources or user_goal_ref',
    );
  } else {
    addPass('P-11', `sources_count: ${proposal.provenance.sources.length}`);
  }

  // --------------------------------------------------------------------------
  // Rule P-12: Fallthrough default ALLOW
  // --------------------------------------------------------------------------
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

/**
 * Convenience wrapper passing named parameters.
 */
export function evaluatePolicyRules(params: EvaluatePolicyParams): Decision {
  return evaluateFullPolicy(params.mandate, params.proposal, params.facts, params.now, {
    hmacKey: params.hmacKey,
    rawJson: params.rawJson,
  });
}

export const evaluatePolicy = evaluateFullPolicy;
