import { scanAdvisoryText } from '@mandatepay/scanner';
import type { PurchaseIntent, LineItem, CurrencyCode, PurchaseIntentProposal } from '@mandatepay/schemas';
import type { LlmClient, LlmMessage } from './llm.js';
import {
  SHOPPER_TOOL_DEFINITIONS,
  executeShopperTool,
  type CatalogService,
  type ControlPlaneClient,
  type ToolExecutionContext,
} from './tools.js';
import { DEFENSIVE_SYSTEM_PROMPT, VULNERABLE_SYSTEM_PROMPT } from './prompts.js';

export interface ShopperAgentConfig {
  mandateId: string;
  agentId?: string | undefined;
  llmClient: LlmClient;
  catalogService: CatalogService;
  controlPlaneClient: ControlPlaneClient;
  mode?: 'defensive' | 'vulnerable' | undefined;
  currency?: string | undefined;
  maxTurns?: number | undefined;
}

export interface ShopperAgentRunResult {
  success: boolean;
  finalText: string;
  proposal: PurchaseIntentProposal | null;
  decision: { verdict: string; reason_codes?: string[]; intent_id?: string } | null;
  transcript: LlmMessage[];
  toolCallsCount: number;
}

/**
 * Autonomous Shopper Agent running inside the isolated Cognitive Plane (spec.md §2, FR-16 to FR-20).
 * CRITICAL ARCHITECTURAL BOUNDARY (INV-1, AC-7):
 * This process possesses ZERO PayPal credentials, payment tokens, or payment APIs.
 * It operates strictly by browsing store catalogs and proposing purchase intents to the trusted Control Plane.
 */
export class ShopperAgent {
  private readonly config: ShopperAgentConfig;

  constructor(config: ShopperAgentConfig) {
    this.config = config;
  }

  /**
   * Pre-screens untrusted web scrape contents with the pure deterministic advisory scanner.
   */
  public screenProductDescription(text: string) {
    return scanAdvisoryText(text);
  }

  /**
   * Executes a shopping goal loop given a user prompt.
   * Runs the tool-use loop: prompts -> search_catalog -> get_item_details -> propose_purchase.
   */
  public async runShoppingGoal(
    userGoal: string,
    goalRef = `msg_${Date.now()}`,
  ): Promise<ShopperAgentRunResult> {
    const mode = this.config.mode ?? 'defensive';
    const systemPrompt = mode === 'defensive' ? DEFENSIVE_SYSTEM_PROMPT : VULNERABLE_SYSTEM_PROMPT;
    const maxTurns = this.config.maxTurns ?? 8;

    const transcript: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userGoal },
    ];

    const visitedSources: Array<{ ref: string; content?: string }> = [];
    const executionCtx: ToolExecutionContext = {
      mandateId: this.config.mandateId,
      userGoalRef: goalRef,
      catalogService: this.config.catalogService,
      controlPlaneClient: this.config.controlPlaneClient,
      visitedSources,
      currency: this.config.currency ?? 'USD',
    };

    let submittedProposal: PurchaseIntentProposal | null = null;
    let controlPlaneDecision: { verdict: string; reason_codes?: string[]; intent_id?: string } | null = null;
    let toolCallsCount = 0;
    let turns = 0;
    let finalText = '';

    while (turns < maxTurns) {
      turns++;

      const response = await this.config.llmClient.complete(transcript, SHOPPER_TOOL_DEFINITIONS);

      transcript.push({
        role: 'assistant',
        content: response.text,
        ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
      });

      if (response.text) {
        finalText = response.text;
      }

      // If no tool calls, the agent has finished speaking to the user
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // Process each requested tool call
      for (const call of response.toolCalls) {
        toolCallsCount++;
        const toolResult = await executeShopperTool(call.name, call.arguments, executionCtx);

        if (toolResult.proposal) {
          submittedProposal = toolResult.proposal;
          try {
            const parsed = JSON.parse(toolResult.output) as {
              verdict?: string;
              reason_codes?: string[];
              intent_id?: string;
            };
            if (parsed.verdict) {
              controlPlaneDecision = {
                verdict: parsed.verdict,
                ...(parsed.reason_codes ? { reason_codes: parsed.reason_codes } : {}),
                ...(parsed.intent_id ? { intent_id: parsed.intent_id } : {}),
              };
            }
          } catch {
            // Non-JSON output
          }
        }

        transcript.push({
          role: 'tool',
          name: call.name,
          tool_call_id: call.id,
          content: toolResult.output,
        });
      }
    }

    const success = Boolean(submittedProposal && controlPlaneDecision?.verdict === 'ALLOW');

    return {
      success,
      finalText,
      proposal: submittedProposal,
      decision: controlPlaneDecision,
      transcript,
      toolCallsCount,
    };
  }

  /**
   * Backwards-compatible helper for creating purchase intent structures for early tests.
   */
  public createPurchaseIntent(params: {
    id: string;
    mandateId: string;
    merchantDomain: string;
    items: LineItem[];
    currency: CurrencyCode;
    nonce: string;
  }): PurchaseIntent {
    const totalAmount = params.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    return {
      id: params.id,
      mandateId: params.mandateId,
      merchantDomain: params.merchantDomain,
      items: params.items,
      totalAmount,
      currency: params.currency,
      nonce: params.nonce,
      timestamp: new Date().toISOString(),
    };
  }
}
