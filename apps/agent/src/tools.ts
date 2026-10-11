import {
  PurchaseIntentProposalSchema,
  type PurchaseIntentProposal,
} from '@mandatepay/schemas';
import type { LlmToolDefinition } from './llm.js';

export interface CatalogItem {
  sku: string;
  name: string;
  price_minor: number;
  category: string;
  description?: string | undefined;
  merchant_ref?: string | undefined;
}

export interface CatalogService {
  search(query: string, merchantRef?: string): Promise<CatalogItem[]>;
  getItem(sku: string, merchantRef: string): Promise<CatalogItem | null>;
}

export interface ControlPlaneClient {
  submitProposal(proposal: PurchaseIntentProposal): Promise<{
    verdict: string;
    reason_codes?: string[];
    intent_id: string;
  }>;
  checkStatus(intentId: string): Promise<{
    status: string;
    verdict?: string;
  }>;
}

/**
 * Standard tool definitions exposed to the Shopper Agent (specs/skill.md §B.2).
 */
export const SHOPPER_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'search_catalog',
    description: 'Search merchant catalog for available products matching a keyword query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, e.g. "pen", "notebook"' },
        merchant_ref: { type: 'string', description: 'Optional merchant ID or domain to search within' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_item_details',
    description: 'Get product details, price, and description for a specific SKU from a merchant.',
    parameters: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Product SKU code, e.g. "SKU-PEN-PACK"' },
        merchant_ref: { type: 'string', description: 'Merchant ID or domain offering the SKU' },
      },
      required: ['sku', 'merchant_ref'],
    },
  },
  {
    name: 'propose_purchase',
    description: 'Submit an untrusted purchase intent proposal to the MandatePay Control Plane for policy evaluation and authorization.',
    parameters: {
      type: 'object',
      properties: {
        merchant_ref: { type: 'string', description: 'Merchant ID or domain for the purchase' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'Product SKU' },
              qty: { type: 'number', description: 'Quantity (positive integer)' },
              claimed_unit_price_minor: { type: 'number', description: 'Price per unit in cents (minor currency units)' },
            },
            required: ['sku', 'qty', 'claimed_unit_price_minor'],
          },
          description: 'Line items to purchase',
        },
        claimed_total_minor: { type: 'number', description: 'Total claimed amount in cents (must match sum of items)' },
        currency: { type: 'string', description: '3-letter currency code (e.g. "USD")' },
        rationale: { type: 'string', description: 'Brief rationale for the purchase (max 280 characters)' },
      },
      required: ['merchant_ref', 'items', 'claimed_total_minor', 'rationale'],
    },
  },
  {
    name: 'check_intent_status',
    description: 'Check the status and decision verdict of a previously submitted purchase intent.',
    parameters: {
      type: 'object',
      properties: {
        intent_id: { type: 'string', description: 'The intent ID (e.g. "int_...")' },
      },
      required: ['intent_id'],
    },
  },
];

export interface ToolExecutionContext {
  mandateId: string;
  userGoalRef: string;
  catalogService: CatalogService;
  controlPlaneClient: ControlPlaneClient;
  visitedSources: Array<{ ref: string; content?: string | undefined }>;
  currency?: string | undefined;
}

/**
 * Executes a tool invocation requested by the Shopper Agent.
 * Enforces schema parsing with Zod and attaches automatic provenance metadata (specs/skill.md §B.5).
 */
export async function executeShopperTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<{ output: string; proposal?: PurchaseIntentProposal | undefined }> {
  switch (name) {
    case 'search_catalog': {
      const query = String(args['query'] ?? '');
      const merchantRef = args['merchant_ref'] ? String(args['merchant_ref']) : undefined;
      const results = await ctx.catalogService.search(query, merchantRef);
      return { output: JSON.stringify(results) };
    }

    case 'get_item_details':
    case 'get_product': {
      const sku = String(args['sku'] ?? '');
      const merchantRef = String(args['merchant_ref'] ?? '');
      const item = await ctx.catalogService.getItem(sku, merchantRef);
      if (!item) {
        return { output: `Item '${sku}' not found at merchant '${merchantRef}'.` };
      }
      ctx.visitedSources.push({
        ref: `${merchantRef}:${sku}`,
        content: item.description,
      });
      return { output: JSON.stringify(item) };
    }

    case 'propose_purchase':
    case 'submit_purchase_intent': {
      const items = (args['items'] as Array<Record<string, unknown>> | undefined) ?? [];
      const claimedTotal = Number(args['claimed_total_minor'] ?? 0);
      const merchantRef = String(args['merchant_ref'] ?? '');
      const rationale = String(args['rationale'] ?? '').slice(0, 280);
      const currency = String(args['currency'] ?? ctx.currency ?? 'USD');

      // Generate a deterministic or randomized intent ID
      const randomNonce = Math.random().toString(36).slice(2, 10);
      const intentId = `int_${Date.now()}_${randomNonce}`;

      // Assemble provenance sources (user message as 'user' trust, web sources as 'untrusted_web' trust)
      const sources: Array<{ kind: 'user' | 'web'; ref: string; trust: 'user' | 'untrusted_web' }> = [
        { kind: 'user', ref: ctx.userGoalRef, trust: 'user' },
      ];
      for (const s of ctx.visitedSources) {
        sources.push({ kind: 'web', ref: s.ref, trust: 'untrusted_web' });
      }

      const rawProposal = {
        intent_id: intentId,
        mandate_id: ctx.mandateId,
        merchant_ref: merchantRef,
        items: items.map((it) => ({
          sku: String(it['sku'] ?? ''),
          qty: Number(it['qty'] ?? 1),
          claimed_unit_price_minor: Number(it['claimed_unit_price_minor'] ?? 0),
        })),
        claimed_total_minor: claimedTotal,
        currency,
        user_goal_ref: ctx.userGoalRef,
        rationale: rationale || 'Automated purchase intent proposed by Shopper Agent',
        provenance: { sources },
      };

      // Strict validation via PurchaseIntentProposalSchema
      const parseResult = PurchaseIntentProposalSchema.safeParse(rawProposal);
      if (!parseResult.success) {
        return {
          output: `Validation error in proposed purchase intent: ${JSON.stringify(parseResult.error.format())}`,
        };
      }

      const validProposal = parseResult.data;
      const submission = await ctx.controlPlaneClient.submitProposal(validProposal);
      return {
        output: JSON.stringify(submission),
        proposal: validProposal,
      };
    }

    case 'check_intent_status': {
      const intentId = String(args['intent_id'] ?? '');
      const statusRes = await ctx.controlPlaneClient.checkStatus(intentId);
      return { output: JSON.stringify(statusRes) };
    }

    default:
      return { output: `Error: Unknown tool '${name}'.` };
  }
}
