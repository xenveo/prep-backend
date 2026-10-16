// The one Gemini client every Gemini adapter shares (plan 01-gemini). It owns the model check, the
// deadline, the finishReason checks, the error taxonomy and usage/cost, so the LLM, STT and TTS
// adapters only map their own request and response shapes.
import {
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type SpeechConfig,
} from '@google/genai';
import { Logger } from '@nestjs/common';
import { GeminiError, toGeminiError } from './gemini.errors.js';
import { geminiCostUsd } from './gemini.pricing.js';

export type GeminiThinkingLevel = 'low' | 'medium' | 'high';

export type GeminiRequest = {
  model: string;
  /** Turns in order; use role 'model' for assistant turns and `inlineData` parts for audio. */
  contents: Content[];
  systemInstruction?: string;
  temperature?: number;
  /** Thinking tokens count against this limit. */
  maxOutputTokens?: number;
  /** Omitted = the model's default. Not for TTS models, which have no thinking. */
  thinkingLevel?: GeminiThinkingLevel;
  /** JSON output: sent as `responseJsonSchema` (never with `responseSchema`), unsupported keywords stripped. */
  jsonSchema?: Record<string, unknown>;
  /** TTS: ['AUDIO']. */
  responseModalities?: string[];
  /** TTS: voice selection. */
  speechConfig?: SpeechConfig;
};

export type GeminiUsage = {
  /** Prompt tokens, audio included. */
  inputTokens: number;
  /** Candidate tokens plus thinking tokens, the billed output. */
  outputTokens: number;
  latencyMs: number;
  costUsd: number | null;
};

export type GeminiResult = {
  /** Checked: not truncated and not blocked. Read audio from its parts. */
  response: GenerateContentResponse;
  usage: GeminiUsage;
};

export type GeminiJsonResult = GeminiResult & {
  /** The JSON text, unparsed. */
  text: string;
};

export type GeminiModelsApi = Pick<
  GoogleGenAI['models'],
  'get' | 'generateContent'
>;

const THINKING: Record<GeminiThinkingLevel, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

const BLOCKED: readonly (FinishReason | undefined)[] = [
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
];

/** Keywords z.toJSONSchema emits that `responseJsonSchema` rejects. Everything else it emits for the AI schemas is accepted. */
const UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema']);

export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
  /** Per model; a failed check is dropped so one bad minute doesn't stick. */
  private readonly modelChecks = new Map<string, Promise<void>>();
  private api?: GeminiModelsApi;

  /** `models` is for tests. Without it the SDK client is built on first use, so an unused client needs no key. */
  constructor(
    private readonly opts: { apiKey?: string; timeoutMs: number },
    models?: GeminiModelsApi,
  ) {
    this.api = models;
  }

  /**
   * Resolves when the model is served, once per process per model. A 404 rejects with
   * `model_not_found` and a 400 with `bad_request` (both definitive); anything else is transient.
   */
  ensureModel(model: string): Promise<void> {
    const existing = this.modelChecks.get(model);
    if (existing) return existing;
    const check = this.withDeadline((abortSignal) =>
      this.models().get({ model, config: { abortSignal } }),
    ).then(
      () => {
        this.logger.log(`Gemini model ${model} is available`);
      },
      (err: unknown) => {
        this.modelChecks.delete(model);
        throw err;
      },
    );
    this.modelChecks.set(model, check);
    return check;
  }

  /** One `generateContent` call with the model check, deadline and finishReason checks. */
  async generate(req: GeminiRequest): Promise<GeminiResult> {
    await this.ensureModel(req.model);
    const started = Date.now();
    const response = await this.withDeadline((abortSignal) =>
      this.models().generateContent({
        model: req.model,
        contents: req.contents,
        config: toConfig(req, abortSignal),
      }),
    );
    const latencyMs = Date.now() - started;
    checkFinish(response);

    const meta = response.usageMetadata;
    const inputTokens = meta?.promptTokenCount ?? 0;
    const outputTokens =
      (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
    return {
      response,
      usage: {
        inputTokens,
        outputTokens,
        latencyMs,
        costUsd: geminiCostUsd(req.model, inputTokens, outputTokens),
      },
    };
  }

  /** `generate` with JSON output; rejects with `empty` when no text came back. */
  async generateJson(
    req: GeminiRequest & { jsonSchema: Record<string, unknown> },
  ): Promise<GeminiJsonResult> {
    const result = await this.generate(req);
    const text = result.response.text;
    if (!text) throw new GeminiError('empty', 'Gemini returned no text', true);
    return { ...result, text };
  }

  private models(): GeminiModelsApi {
    if (!this.api) {
      if (!this.opts.apiKey)
        throw new GeminiError('forbidden', 'GEMINI_API_KEY is not set', false);
      this.api = new GoogleGenAI({ apiKey: this.opts.apiKey }).models;
    }
    return this.api;
  }

  /** Aborts after GEMINI_TIMEOUT_MS and maps every failure to a GeminiError. */
  private async withDeadline<T>(
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await call(controller.signal);
    } catch (err) {
      throw toGeminiError(err, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Removes keywords Gemini rejects, at any depth. The shared Zod-derived schemas stay untouched. */
export function toGeminiJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !UNSUPPORTED_SCHEMA_KEYS.has(key))
      .map(([key, value]) => [key, toGeminiJsonSchema(value)]),
  );
}

function toConfig(
  req: GeminiRequest,
  abortSignal: AbortSignal,
): GenerateContentConfig {
  return {
    abortSignal,
    ...(req.systemInstruction !== undefined && {
      systemInstruction: req.systemInstruction,
    }),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.maxOutputTokens !== undefined && {
      maxOutputTokens: req.maxOutputTokens,
    }),
    ...(req.thinkingLevel && {
      thinkingConfig: { thinkingLevel: THINKING[req.thinkingLevel] },
    }),
    ...(req.jsonSchema && {
      responseMimeType: 'application/json',
      responseJsonSchema: toGeminiJsonSchema(req.jsonSchema),
    }),
    ...(req.responseModalities && {
      responseModalities: req.responseModalities,
    }),
    ...(req.speechConfig && { speechConfig: req.speechConfig }),
  };
}

/** Checked before reading `.text`: a truncated response still has text, which would parse as bad JSON. */
function checkFinish(response: GenerateContentResponse): void {
  if (response.promptFeedback?.blockReason)
    throw new GeminiError('blocked', 'Gemini blocked the prompt', false);
  const finish = response.candidates?.[0]?.finishReason;
  if (finish === FinishReason.MAX_TOKENS)
    throw new GeminiError(
      'max_tokens',
      'Gemini hit the output token limit (thinking counts against it)',
      false,
    );
  if (BLOCKED.includes(finish))
    throw new GeminiError(
      'blocked',
      `Gemini blocked the response (${finish})`,
      false,
    );
}
