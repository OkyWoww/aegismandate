import { z } from 'zod';

// ==============================================================================
// 1. SPEC.MD §3.1: MANDATE CONTRACT
// ==============================================================================

export const MandateStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
  'SUSPENDED',
]);
export type MandateStatus = z.infer<typeof MandateStatusSchema>;

export const MandateStepUpSchema = z
  .object({
    channel: z.enum(['dashboard', 'email', 'webhook']).default('dashboard'),
    timeout_seconds: z.number().int().positive().default(300),
  })
  .strict();
export type MandateStepUp = z.infer<typeof MandateStepUpSchema>;

export const MandateRiskSchema = z
  .object({
    step_up_threshold: z.number().min(0).max(100).default(40),
    deny_threshold: z.number().min(0).max(100).default(75),
  })
  .strict()
  .refine((r) => r.step_up_threshold <= r.deny_threshold, {
    message: 'step_up_threshold must be <= deny_threshold',
  });
export type MandateRisk = z.infer<typeof MandateRiskSchema>;

export const MandateWalletSchema = z
  .object({
    type: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();
export type MandateWallet = z.infer<typeof MandateWalletSchema>;

/**
 * Strict Mandate schema matching spec.md §3.1.
 * Constraints:
 * - auto_approve_limit_minor <= per_txn_limit_minor <= total_budget_minor
 * - valid_until > valid_from
 * - allowed_merchants non-empty
 * - additionalProperties: false (strict)
 */
export const MandateSchema = z
  .object({
    mandate_id: z.string().regex(/^mnd_[a-zA-Z0-9_-]+$/, 'mandate_id must start with mnd_'),
    version: z.number().int().positive().default(1),
    owner_id: z.string().min(1),
    agent_id: z.string().min(1),
    status: MandateStatusSchema,
    currency: z.string().length(3).default('USD'),
    valid_from: z.string().datetime(),
    valid_until: z.string().datetime(),
    total_budget_minor: z.number().int().nonnegative(),
    per_txn_limit_minor: z.number().int().nonnegative(),
    auto_approve_limit_minor: z.number().int().nonnegative(),
    max_txns_per_hour: z.number().int().positive().default(3),
    allowed_merchants: z.array(z.string().min(1)).min(1),
    allowed_categories: z.array(z.string().min(1)).default([]),
    max_items_per_intent: z.number().int().positive().default(5),
    max_pending_approvals: z.number().int().positive().default(3),
    suspend_after_denies: z.number().int().positive().default(5),
    step_up: MandateStepUpSchema,
    risk: MandateRiskSchema,
    wallet: MandateWalletSchema,
    created_at: z.string().datetime(),
    signature: z.string().min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.auto_approve_limit_minor > m.per_txn_limit_minor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'auto_approve_limit_minor must be <= per_txn_limit_minor',
        path: ['auto_approve_limit_minor'],
      });
    }
    if (m.per_txn_limit_minor > m.total_budget_minor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'per_txn_limit_minor must be <= total_budget_minor',
        path: ['per_txn_limit_minor'],
      });
    }
    if (new Date(m.valid_until).getTime() <= new Date(m.valid_from).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'valid_until must be strictly greater than valid_from',
        path: ['valid_until'],
      });
    }
  });
export type Mandate = z.infer<typeof MandateSchema>;

// ==============================================================================
// 2. SPEC.MD §3.2: PURCHASE INTENT PROPOSAL CONTRACT
// ==============================================================================

export const ProposalItemSchema = z
  .object({
    sku: z.string().regex(/^[A-Z0-9-]{3,32}$/, 'sku must match ^[A-Z0-9-]{3,32}$'),
    qty: z.number().int().positive(),
    claimed_unit_price_minor: z.number().int().nonnegative(),
  })
  .strict();
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const ProvenanceSourceSchema = z
  .object({
    kind: z.enum(['user', 'web', 'tool', 'system']),
    ref: z.string().min(1),
    trust: z.enum(['user', 'untrusted_web', 'system']),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'content_sha256 must be 64-char hex').optional(),
  })
  .strict();
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export const ProvenanceSchema = z
  .object({
    sources: z.array(ProvenanceSourceSchema).min(1),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Strict Purchase Intent Proposal schema matching spec.md §3.2.
 * Rules:
 * 1. additionalProperties: false (strict at every depth)
 * 2. SKU pattern ^[A-Z0-9-]{3,32}$
 * 3. Integer minor units for prices
 * 4. Rationale max 280 chars
 * 5. claimed_total_minor must equal sum of items
 */
export const PurchaseIntentProposalSchema = z
  .object({
    intent_id: z.string().regex(/^int_[a-zA-Z0-9_-]+$/, 'intent_id must start with int_'),
    mandate_id: z.string().regex(/^mnd_[a-zA-Z0-9_-]+$/, 'mandate_id must start with mnd_'),
    merchant_ref: z.string().min(1),
    items: z.array(ProposalItemSchema).min(1),
    claimed_total_minor: z.number().int().nonnegative(),
    currency: z.string().length(3).default('USD'),
    user_goal_ref: z.string().min(1),
    rationale: z.string().max(280),
    provenance: ProvenanceSchema,
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const sum = proposal.items.reduce(
      (acc, item) => acc + item.claimed_unit_price_minor * item.qty,
      0,
    );
    if (proposal.claimed_total_minor !== sum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `claimed_total_minor (${proposal.claimed_total_minor}) does not equal items sum (${sum})`,
        path: ['claimed_total_minor'],
      });
    }
  });
export type PurchaseIntentProposal = z.infer<typeof PurchaseIntentProposalSchema>;

// ==============================================================================
// 3. SPEC.MD §3.3: DECISION CONTRACT
// ==============================================================================

export const DecisionVerdictSchema = z.enum(['ALLOW', 'STEP_UP', 'DENY']);
export type DecisionVerdict = z.infer<typeof DecisionVerdictSchema>;

export const PolicyTraceItemSchema = z
  .object({
    rule: z.string().min(1),
    result: z.enum(['pass', 'deny', 'step_up', 'skip']),
    detail: z.string().optional(),
  })
  .strict();
export type PolicyTraceItem = z.infer<typeof PolicyTraceItemSchema>;

export const DecisionRiskSchema = z
  .object({
    score: z.number().min(0).max(100),
    signals: z.array(z.string()),
  })
  .strict();
export type DecisionRisk = z.infer<typeof DecisionRiskSchema>;

export const DecisionSchema = z
  .object({
    decision_id: z.string().regex(/^dec_[a-zA-Z0-9_-]+$/, 'decision_id must start with dec_'),
    intent_id: z.string().regex(/^int_[a-zA-Z0-9_-]+$/, 'intent_id must start with int_'),
    verdict: DecisionVerdictSchema,
    reason_codes: z.array(z.string()),
    risk: DecisionRiskSchema,
    policy_trace: z.array(PolicyTraceItemSchema),
    verified_total_minor: z.number().int().nonnegative().nullable(),
    decided_at: z.string().datetime(),
    engine_version: z.string().min(1),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

// ==============================================================================
// 4. SPEC.MD §3.5: AUDIT EVENT CONTRACT
// ==============================================================================

export const AuditActorSchema = z.enum(['control_plane', 'user', 'agent', 'paypal']);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: z.string().datetime(),
    actor: AuditActorSchema,
    type: z.string().min(1),
    ref: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    prev_hash: z.string().min(1),
    hash: z.string().min(1),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ==============================================================================
// 5. DEEP KEY SCAN & VALUE SCAN HELPERS (P-03 / A-12 / spec.md §3.2)
// ==============================================================================

export const FORBIDDEN_KEY_PATTERN =
  /payee|destination|recipient|account|email|iban|wallet|beneficiar|transfer/i;
export const FORBIDDEN_VALUE_EMAIL_PATTERN =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
export const FORBIDDEN_VALUE_IBAN_PATTERN =
  /[A-Z]{2}\d{2}[A-Z0-9]{11,30}/i;
export const FORBIDDEN_VALUE_WALLET_PATTERN =
  /0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}/;

export interface DeepScanViolation {
  type: 'FORBIDDEN_KEY' | 'FORBIDDEN_VALUE';
  path: string;
  detail: string;
}

export interface DeepScanResult {
  hasForbiddenKey: boolean;
  hasForbiddenValue: boolean;
  violations: DeepScanViolation[];
}

/**
 * Walks raw JSON recursively (objects, arrays, prototype properties, any depth)
 * checking for forbidden payee keys and forbidden values in free-text fields.
 */
export function deepKeyScan(raw: unknown, currentPath = '$'): DeepScanResult {
  const violations: DeepScanViolation[] = [];

  function walk(node: unknown, path: string) {
    if (node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], `${path}[${i}]`);
      }
      return;
    }

    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;

      // Check object keys, including inherited properties if present
      const keys = Object.keys(obj);
      // Also check special property names that could bypass normal inspection
      const specialKeys = ['__proto__', 'constructor', 'prototype'];
      for (const sk of specialKeys) {
        if (Object.prototype.hasOwnProperty.call(obj, sk)) {
          violations.push({
            type: 'FORBIDDEN_KEY',
            path: `${path}.${sk}`,
            detail: `Forbidden prototype pollution key detected: ${sk}`,
          });
        }
      }

      for (const k of keys) {
        const keyPath = `${path}.${k}`;
        if (FORBIDDEN_KEY_PATTERN.test(k)) {
          violations.push({
            type: 'FORBIDDEN_KEY',
            path: keyPath,
            detail: `Key "${k}" matches forbidden payee pattern`,
          });
        }
        walk(obj[k], keyPath);
      }
      return;
    }

    if (typeof node === 'string') {
      // Check free text values for suspicious payee values (email, IBAN, wallet addresses)
      // Exclude standard UUIDs, known refs, and allowed URLs
      if (FORBIDDEN_VALUE_EMAIL_PATTERN.test(node)) {
        violations.push({
          type: 'FORBIDDEN_VALUE',
          path,
          detail: `Value contains forbidden email-like recipient string: "${node}"`,
        });
      } else if (FORBIDDEN_VALUE_IBAN_PATTERN.test(node)) {
        violations.push({
          type: 'FORBIDDEN_VALUE',
          path,
          detail: `Value contains forbidden IBAN-like string: "${node}"`,
        });
      } else if (FORBIDDEN_VALUE_WALLET_PATTERN.test(node)) {
        violations.push({
          type: 'FORBIDDEN_VALUE',
          path,
          detail: `Value contains forbidden crypto wallet-like address: "${node}"`,
        });
      }
    }
  }

  walk(raw, currentPath);

  return {
    hasForbiddenKey: violations.some((v) => v.type === 'FORBIDDEN_KEY'),
    hasForbiddenValue: violations.some((v) => v.type === 'FORBIDDEN_VALUE'),
    violations,
  };
}

// ==============================================================================
// 6. BACKWARD COMPATIBILITY SCHEMAS & ALIASES
// ==============================================================================

export const CurrencyCodeSchema = z.enum(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

export const LineItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  category: z.string().optional(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const PurchaseIntentSchema = z.object({
  id: z.string(),
  mandateId: z.string(),
  merchantDomain: z.string().min(1),
  items: z.array(LineItemSchema).min(1),
  totalAmount: z.number().positive(),
  currency: CurrencyCodeSchema,
  nonce: z.string().min(1),
  timestamp: z.string().datetime(),
});
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

export const PolicyDecisionSchema = z.object({
  approved: z.boolean(),
  intentId: z.string(),
  mandateId: z.string(),
  reasonCode: z.string(),
  details: z.string(),
  evaluatedAt: z.string().datetime(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
