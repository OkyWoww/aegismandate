export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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
