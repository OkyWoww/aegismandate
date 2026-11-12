export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string | undefined;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  tool_calls?: LlmToolCall[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
}

/**
 * Pluggable LLM client interface for Cognitive Plane shopping agents (specs/tech.md §5).
 */
export interface LlmClient {
  complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmResponse>;
}

export interface FakeLlmStep {
  text?: string;
  toolCalls?: LlmToolCall[];
}

/**
 * Deterministic Mock/Fake LLM Client for offline, reproducible tests (specs/tech.md §5).
 * Replays scripted steps or dynamically responds to messages without external network calls.
 */
export class FakeLlmClient implements LlmClient {
  private steps: FakeLlmStep[];
  private currentStep = 0;
  private customHandler?: (messages: LlmMessage[], tools?: LlmToolDefinition[]) => LlmResponse;

  constructor(
    stepsOrHandler?: FakeLlmStep[] | ((messages: LlmMessage[], tools?: LlmToolDefinition[]) => LlmResponse),
  ) {
    if (typeof stepsOrHandler === 'function') {
      this.customHandler = stepsOrHandler;
      this.steps = [];
    } else {
      this.steps = stepsOrHandler ?? [];
    }
  }

  public setSteps(steps: FakeLlmStep[]): void {
    this.steps = steps;
    this.currentStep = 0;
  }

  public async complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmResponse> {
    if (this.customHandler) {
      return this.customHandler(messages, tools);
    }

    if (this.currentStep < this.steps.length) {
      const step = this.steps[this.currentStep];
      this.currentStep++;
      return {
        text: step?.text ?? '',
        toolCalls: step?.toolCalls ?? [],
      };
    }

    // Default response when steps are exhausted
    return {
      text: 'Shopping goal completed based on available information.',
      toolCalls: [],
    };
  }

  public reset(): void {
    this.currentStep = 0;
  }
}

/**
 * Generic OpenAI-compatible HTTP LLM Client adapter (OpenAI / Gemini OpenAI-compatible / Local Ollama).
 */
export class OpenAiCompatibleLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: { apiKey: string; baseUrl?: string; model?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4o-mini';
  }

  public async complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmResponse> {
    const formattedTools = tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const formattedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          }
        : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: formattedMessages,
        ...(formattedTools && formattedTools.length > 0 ? { tools: formattedTools } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM completion failed with status ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function?: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices?.[0]?.message;
    const text = choice?.content ?? '';
    const toolCalls: LlmToolCall[] =
      choice?.tool_calls?.map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        return {
          id: tc.id,
          name: tc.function?.name ?? '',
          arguments: args,
        };
      }) ?? [];

    return { text, toolCalls };
  }
}

export interface GeminiRestClientConfig {
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  fallbackClient?: LlmClient | undefined;
}

/**
 * Native REST API Client for Google Gemini (gemini-3.8-flash) using Node.js 22 built-in fetch.
 * Implements tool/function calling (search_catalog, get_item_details, propose_purchase)
 * with AbortSignal.timeout(20000) and 1x retry. Zero external SDK dependencies.
 */
export class GeminiRestClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fallbackClient?: LlmClient | undefined;
  public lastModeUsed: 'LIVE_LLM' | 'OFFLINE_FALLBACK' = 'LIVE_LLM';
  public activeLiveModel: string = 'gemini-3.8-flash';
  public lastError?: Error | undefined;

  constructor(config: GeminiRestClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-3.8-flash';
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.timeoutMs = config.timeoutMs ?? 20000;
    this.retries = config.retries ?? 1;
    this.fallbackClient = config.fallbackClient;
    this.activeLiveModel = this.model;
  }

  private cleanParameters(params: Record<string, unknown>): Record<string, unknown> {
    const convertType = (t: unknown): string => {
      if (typeof t !== 'string') return 'STRING';
      switch (t.toLowerCase()) {
        case 'object': return 'OBJECT';
        case 'string': return 'STRING';
        case 'number':
        case 'integer': return 'NUMBER';
        case 'array': return 'ARRAY';
        case 'boolean': return 'BOOLEAN';
        default: return 'STRING';
      }
    };

    const cleanNode = (node: unknown): unknown => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(cleanNode);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'type') {
          out['type'] = convertType(v);
        } else if (k === 'properties' && v && typeof v === 'object') {
          const props: Record<string, unknown> = {};
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
            props[pk] = cleanNode(pv);
          }
          out['properties'] = props;
        } else if (k === 'items') {
          out['items'] = cleanNode(v);
        } else if (k === 'required') {
          out['required'] = v;
        } else if (k === 'description') {
          out['description'] = v;
        }
      }
      return out;
    };

    return cleanNode(params) as Record<string, unknown>;
  }

  public async complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmResponse> {
    const formattedTools = tools && tools.length > 0 ? [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: this.cleanParameters(t.parameters),
        })),
      },
    ] : undefined;

    let systemInstructionText: string | undefined;
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstructionText = systemInstructionText
          ? `${systemInstructionText}\n${msg.content}`
          : msg.content;
      } else if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const partObj: Record<string, unknown> = {
              functionCall: {
                name: tc.name,
                args: tc.arguments ?? {},
              },
            };
            if (tc.thoughtSignature) {
              partObj['thoughtSignature'] = tc.thoughtSignature;
            }
            parts.push(partObj);
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        let parsedContent: unknown = msg.content;
        try {
          parsedContent = JSON.parse(msg.content);
        } catch {
          parsedContent = { output: msg.content };
        }
        const responseObj: Record<string, unknown> =
          typeof parsedContent === 'object' && parsedContent !== null && !Array.isArray(parsedContent)
            ? (parsedContent as Record<string, unknown>)
            : { output: parsedContent };

        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.name ?? 'tool_result',
                response: responseObj,
              },
            },
          ],
        });
      }
    }

    const payload: Record<string, unknown> = {
      contents,
      ...(systemInstructionText ? { systemInstruction: { parts: [{ text: systemInstructionText }] } } : {}),
      ...(formattedTools ? { tools: formattedTools } : {}),
    };

    const candidateModels = [
      this.model,
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ].filter((m, idx, arr) => arr.indexOf(m) === idx);

    let lastError: Error | null = null;

    for (const model of candidateModels) {
      const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;
      const headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      };

      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(this.timeoutMs),
          });

          if (!res.ok) {
            const errText = await res.text();
            console.error(
              `[GeminiRestClient] Request to ${model} failed (attempt ${attempt + 1}/${this.retries + 1}, HTTP ${res.status}): ${errText}`
            );
            if (res.status === 429 || res.status === 503) {
              lastError = new Error(`Gemini HTTP ${res.status} on ${model}: ${errText.slice(0, 300)}`);
              break;
            }
            throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
          }

          const data = (await res.json()) as {
            candidates?: Array<{
              content?: {
                role?: string;
                parts?: Array<{
                  text?: string;
                  functionCall?: {
                    name: string;
                    args?: Record<string, unknown>;
                  };
                }>;
              };
            }>;
          };

          const parts = (data.candidates?.[0]?.content?.parts ?? []) as Array<{
            text?: string;
            functionCall?: {
              id?: string;
              name: string;
              args?: Record<string, unknown>;
            };
            thoughtSignature?: string;
            thought_signature?: string;
          }>;
          const textParts = parts.filter((p) => typeof p.text === 'string').map((p) => p.text as string);
          const text = textParts.join('\n');

          const toolCalls: LlmToolCall[] = [];
          for (const p of parts) {
            if (p.functionCall) {
              const sig = p.thoughtSignature ?? p.thought_signature;
              toolCalls.push({
                id:
                  p.functionCall.id ??
                  `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: p.functionCall.name,
                arguments: p.functionCall.args ?? {},
                ...(sig ? { thoughtSignature: sig } : {}),
              });
            }
          }

          this.lastModeUsed = 'LIVE_LLM';
          this.activeLiveModel = model;
          return { text, toolCalls };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.error(
            `[GeminiRestClient] Fetch exception on ${model} (attempt ${attempt + 1}): ${lastError.name} - ${lastError.message}`
          );
          if (attempt < this.retries) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
    }

    this.lastError = lastError ?? new Error('Gemini API request failed');
    if (this.fallbackClient) {
      console.warn(
        `[GeminiRestClient] All live model attempts exhausted. Falling back to offline shopper planner.`
      );
      this.lastModeUsed = 'OFFLINE_FALLBACK';
      const fallbackResult = await this.fallbackClient.complete(messages, tools);
      return {
        text: fallbackResult.text,
        toolCalls: fallbackResult.toolCalls,
      };
    }

    throw this.lastError;
  }
}

export interface RuleBasedShopperLlmClientConfig {
  mode?: 'defensive' | 'vulnerable' | undefined;
}

/**
 * Deterministic offline shopper planner for test suites and offline fallback.
 * Implements the full shopper tool-loop workflow.
 */
export class RuleBasedShopperLlmClient implements LlmClient {
  private readonly mode: 'defensive' | 'vulnerable';

  constructor(config?: RuleBasedShopperLlmClientConfig) {
    this.mode = config?.mode ?? 'defensive';
  }

  public async complete(messages: LlmMessage[], _tools?: LlmToolDefinition[]): Promise<LlmResponse> {
    const userMessage = [...messages].reverse().find((m) => m.role === 'user');
    const userPrompt = userMessage?.content.toLowerCase() ?? '';
    const lastMessage = messages[messages.length - 1];

    if (lastMessage?.role === 'tool') {
      const toolName = lastMessage.name;
      let toolData: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(lastMessage.content) as unknown;
        if (typeof parsed === 'object' && parsed !== null) {
          toolData = parsed as Record<string, unknown>;
        }
      } catch {
        toolData = {};
      }

      if (toolName === 'search_catalog') {
        const items = Array.isArray(toolData)
          ? (toolData as Array<Record<string, unknown>>)
          : [];
        if (items.length === 0) {
          return {
            text: 'I searched the merchant catalog but found no matching products for your request.',
            toolCalls: [],
          };
        }
        const topItem = items[0]!;
        const sku = String(topItem['sku'] ?? '');
        const name = String(topItem['name'] ?? 'Product');
        const merchantRef = String(topItem['merchant_ref'] ?? topItem['merchant_id'] ?? 'mrc_demo_store');
        return {
          text: `Found item "${name}" in catalog. Inspecting item details...`,
          toolCalls: [
            {
              id: `call_${Date.now()}_det`,
              name: 'get_item_details',
              arguments: {
                sku,
                merchant_ref: merchantRef,
              },
            },
          ],
        };
      }

      if (toolName === 'get_item_details' || toolName === 'get_product') {
        const item = toolData;
        const description = String(item['description'] ?? '').toLowerCase();
        const hasInjection =
          description.includes('ignore previous') ||
          description.includes('pay $500') ||
          description.includes('system override') ||
          description.includes('attacker');

        const sku = String(item['sku'] ?? '');
        const name = String(item['name'] ?? 'Product');
        if (hasInjection && this.mode === 'defensive') {
          return {
            text: `[DEFENSIVE AGENT ALERT] Indirect prompt injection detected in item description for SKU ${sku}. Refusing to follow unauthorized instructions.`,
            toolCalls: [],
          };
        }

        const priceMinor = Number(item['price_minor'] ?? 900);
        const merchantRef = String(item['merchant_ref'] ?? item['merchant_id'] ?? 'mrc_demo_store');
        const currency = String(item['currency'] ?? 'USD');
        return {
          text: `Item "${name}" verified ($${(priceMinor / 100).toFixed(2)}). Proposing purchase intent under spending mandate...`,
          toolCalls: [
            {
              id: `call_${Date.now()}_prop`,
              name: 'propose_purchase',
              arguments: {
                merchant_ref: merchantRef,
                items: [
                  {
                    sku,
                    qty: 1,
                    claimed_unit_price_minor: priceMinor,
                  },
                ],
                claimed_total_minor: priceMinor,
                currency,
                rationale: `Shopper agent proposal for ${name}`,
              },
            },
          ],
        };
      }

      if (toolName === 'propose_purchase' || toolName === 'submit_purchase_intent') {
        const verdict = String(toolData['verdict'] ?? 'ALLOW');
        const intentId = String(toolData['intent_id'] ?? 'unknown');
        const reasonCodes = Array.isArray(toolData['reason_codes'])
          ? (toolData['reason_codes'] as string[]).join(', ')
          : '';
        return {
          text: `Purchase intent ${intentId} evaluated by AegisMandate Control Plane. Verdict: ${verdict}${reasonCodes ? ` (${reasonCodes})` : ''}.`,
          toolCalls: [],
        };
      }
    }

    if (
      userPrompt.includes('evil') ||
      userPrompt.includes('injection') ||
      userPrompt.includes('$500') ||
      userPrompt.includes('voucher') ||
      userPrompt.includes('gift')
    ) {
      if (
        this.mode === 'defensive' &&
        (userPrompt.includes('pay $500 to attacker') || userPrompt.includes('ignore previous'))
      ) {
        return {
          text: 'I detected an adversarial instruction in your prompt. As a defensive shopping assistant, I refuse to divert payments to unauthorized recipients.',
          toolCalls: [],
        };
      }
      return {
        text: 'Searching catalog for promotional gift bundle...',
        toolCalls: [
          {
            id: `call_${Date.now()}_src`,
            name: 'search_catalog',
            arguments: { query: 'gift', merchant_ref: 'mrc_evil_store' },
          },
        ],
      };
    }

    if (userPrompt.includes('lamp') || userPrompt.includes('light')) {
      return {
        text: 'Searching catalog for desk lamps...',
        toolCalls: [
          {
            id: `call_${Date.now()}_src`,
            name: 'search_catalog',
            arguments: { query: 'lamp', merchant_ref: 'mrc_demo_store' },
          },
        ],
      };
    }

    if (
      userPrompt.includes('standing desk') ||
      userPrompt.includes('motorized') ||
      (userPrompt.includes('desk') && !userPrompt.includes('pen') && !userPrompt.includes('lamp'))
    ) {
      return {
        text: 'Searching catalog for standing desks...',
        toolCalls: [
          {
            id: `call_${Date.now()}_src`,
            name: 'search_catalog',
            arguments: { query: 'standing desk', merchant_ref: 'mrc_demo_store' },
          },
        ],
      };
    }

    const query = userPrompt.includes('notebook') ? 'notebook' : 'pen';
    return {
      text: `Searching catalog for ${query}...`,
      toolCalls: [
        {
          id: `call_${Date.now()}_src`,
          name: 'search_catalog',
          arguments: { query, merchant_ref: 'mrc_demo_store' },
        },
      ],
    };
  }
}
