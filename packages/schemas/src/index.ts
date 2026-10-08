import { z } from 'zod';

export const CurrencyCodeSchema = z.enum(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

export const MandateScopeSchema = z.object({
  merchantWhitelist: z.array(z.string().min(1)).min(1),
  allowedCategories: z.array(z.string().min(1)).optional(),
  forbiddenCategories: z.array(z.string().min(1)).default(['gift_cards', 'cryptocurrency', 'adult']),
  maxPerItem: z.number().positive(),
  maxTotalBudget: z.number().positive(),
  currency: CurrencyCodeSchema.default('USD'),
});
export type MandateScope = z.infer<typeof MandateScopeSchema>;

export const MandateSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  scope: MandateScopeSchema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  hmacSignature: z.string().min(1),
  status: z.enum(['active', 'exhausted', 'revoked', 'expired']).default('active'),
});
export type Mandate = z.infer<typeof MandateSchema>;

export const LineItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  category: z.string().optional(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const PurchaseIntentSchema = z.object({
  id: z.string().uuid(),
  mandateId: z.string().uuid(),
  merchantDomain: z.string().min(1),
  items: z.array(LineItemSchema).min(1),
  totalAmount: z.number().positive(),
  currency: CurrencyCodeSchema,
  nonce: z.string().min(8),
  timestamp: z.string().datetime(),
});
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

export const PolicyDecisionSchema = z.object({
  approved: z.boolean(),
  intentId: z.string().uuid(),
  mandateId: z.string().uuid(),
  reasonCode: z.enum([
    'APPROVED',
    'BUDGET_EXCEEDED',
    'ITEM_CAP_EXCEEDED',
    'MERCHANT_NOT_ALLOWED',
    'MANDATE_EXPIRED',
    'CATEGORY_FORBIDDEN',
    'CURRENCY_MISMATCH',
    'INVALID_SIGNATURE',
    'NONCE_REPLAY',
    'PRICE_MISMATCH',
  ]),
  details: z.string(),
  evaluatedAt: z.string().datetime(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const AuditEventSchema = z.object({
  sequenceNumber: z.number().int().nonnegative(),
  eventId: z.string().uuid(),
  eventType: z.enum([
    'MANDATE_CREATED',
    'INTENT_SUBMITTED',
    'POLICY_EVALUATED',
    'ORDER_CAPTURED',
    'REJECTION_RECORDED',
    'TAMPER_ALERT',
  ]),
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
  previousHash: z.string(),
  currentHash: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
