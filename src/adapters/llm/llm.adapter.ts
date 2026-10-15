// LLM provider contract (plan §1). Model ids and temperatures come from prompt_versions, never env.

export const LLM_ADAPTER = Symbol('LLM_ADAPTER');

export type LlmMessage = { role: 'user' | 'assistant'; content: string };

export type LlmJsonRequest = {
  /** Which prompt this is ('evaluator', 'summariser', 'interviewer', 'draft-cards', 'draft-questions'). The fake adapter keys canned outputs on it; real adapters use it only for logging. */
  tag: string;
  model: string;
  temperature: number;
  system: string;
  messages: LlmMessage[];
  /** JSON Schema the output must follow (from z.toJSONSchema). The caller still validates with Zod. */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
};

export type LlmUsage = { inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number | null };

export type LlmJsonResult = {
  /** Parsed JSON, unvalidated. */
  output: unknown;
  /** Raw text, for the "retry with validation error" step. */
  raw: string;
  provider: string;
  model: string;
  usage: LlmUsage;
};

export interface LlmAdapter {
  readonly provider: string;
  json(req: LlmJsonRequest): Promise<LlmJsonResult>;
}

/** Thrown for provider outages, timeouts and refusals. Callers map it to `ai_unavailable`. */
export class LlmUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
