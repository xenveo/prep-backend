import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmAdapter,
  LlmJsonRequest,
  LlmJsonResult,
} from './llm.adapter.js';
import { LlmUnavailableError } from './llm.adapter.js';

const TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 2000;

type ModelInfo = {
  /** USD per million input tokens. */
  inputUsd: number;
  /** USD per million output tokens. */
  outputUsd: number;
  /** Newer models reject sampling parameters with a 400, so temperature is only sent where accepted. */
  acceptsTemperature: boolean;
};

/** First-party list prices. Unknown models are still called, with `costUsd: null` and no temperature. */
export const ANTHROPIC_MODELS: Record<string, ModelInfo> = {
  'claude-opus-5-5': { inputUsd: 4, outputUsd: 20, acceptsTemperature: false },
  'claude-opus-5': { inputUsd: 5, outputUsd: 25, acceptsTemperature: false },
  'claude-opus-4-8': { inputUsd: 5, outputUsd: 25, acceptsTemperature: false },
  'claude-opus-4-7': { inputUsd: 5, outputUsd: 25, acceptsTemperature: false },
  'claude-opus-4-6': { inputUsd: 5, outputUsd: 25, acceptsTemperature: true },
  'claude-sonnet-5-5': {
    inputUsd: 2,
    outputUsd: 10,
    acceptsTemperature: false,
  },
  'claude-sonnet-5': { inputUsd: 2, outputUsd: 10, acceptsTemperature: false },
  'claude-sonnet-4-6': { inputUsd: 3, outputUsd: 15, acceptsTemperature: true },
  'claude-haiku-5-5': {
    inputUsd: 0.1,
    outputUsd: 0.5,
    acceptsTemperature: false,
  },
  'claude-haiku-4-5': { inputUsd: 1, outputUsd: 5, acceptsTemperature: true },
};

export function llmCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const info = ANTHROPIC_MODELS[model];
  if (!info) return null;
  return (
    (inputTokens * info.inputUsd + outputTokens * info.outputUsd) / 1_000_000
  );
}

type MessagesClient = Pick<Anthropic, 'messages'>;

export class AnthropicLlmAdapter implements LlmAdapter {
  readonly provider = 'anthropic';
  private readonly client: MessagesClient;

  constructor(
    opts: { apiKey?: string; baseURL?: string },
    client?: MessagesClient,
  ) {
    this.client =
      client ??
      new Anthropic({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
        timeout: TIMEOUT_MS,
        maxRetries: 1,
      });
  }

  async json(req: LlmJsonRequest): Promise<LlmJsonResult> {
    const started = Date.now();
    const info = ANTHROPIC_MODELS[req.model];
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: req.system,
        messages: req.messages,
        output_config: {
          format: { type: 'json_schema', schema: req.jsonSchema },
        },
        ...(info?.acceptsTemperature ? { temperature: req.temperature } : {}),
      });
    } catch (err) {
      throw new LlmUnavailableError(`Anthropic call failed (${req.tag})`, err);
    }
    const latencyMs = Date.now() - started;

    if (message.stop_reason === 'refusal') {
      throw new LlmUnavailableError(
        `Anthropic refused the request (${req.tag})`,
      );
    }

    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let output: unknown = null;
    try {
      output = JSON.parse(raw);
    } catch {
      // Left null: the caller's Zod validation fails and it retries with `raw`.
    }

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    return {
      output,
      raw,
      provider: this.provider,
      model: message.model,
      usage: {
        inputTokens,
        outputTokens,
        latencyMs,
        costUsd: llmCostUsd(req.model, inputTokens, outputTokens),
      },
    };
  }
}
