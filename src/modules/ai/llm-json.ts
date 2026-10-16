// Schema-validated LLM call shared by the AI services: one retry with the validation error appended
// (spec "AI interview pipeline" step 4), and an ai_call_logs row per provider call.
import { z } from 'zod';
import {
  LlmUnavailableError,
  type LlmAdapter,
  type LlmMessage,
} from '../../adapters/llm/llm.adapter.js';
import type { AiCallLogService } from './ai-call-log.service.js';
import type { ActivePrompt } from './prompt.service.js';
import { jsonSchemaOf } from './schemas.js';

/** The model returned output that failed validation twice. */
export class LlmOutputInvalidError extends Error {
  constructor(readonly tag: string) {
    super(`LLM output for ${tag} failed validation twice`);
    this.name = 'LlmOutputInvalidError';
  }
}

export type ValidatedCall<T> = {
  /** LlmJsonRequest.tag */
  tag: string;
  prompt: ActivePrompt;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Extra semantic check after the schema passes; returns an error message or null. */
  check?: (output: T) => string | null;
  sessionId?: string | null;
  attemptId?: string | null;
  maxTokens?: number;
};

const MAX_ATTEMPTS = 2;

/**
 * Calls the LLM and validates its JSON. Throws LlmUnavailableError on a provider failure and
 * LlmOutputInvalidError when the retry also fails validation.
 */
export async function requestValidated<T>(
  llm: LlmAdapter,
  callLog: AiCallLogService,
  call: ValidatedCall<T>,
): Promise<T> {
  const jsonSchema = jsonSchemaOf(call.schema);
  const messages: LlmMessage[] = [{ role: 'user', content: call.user }];
  const logBase = {
    sessionId: call.sessionId,
    attemptId: call.attemptId,
    kind: 'llm' as const,
    provider: llm.provider,
    model: call.prompt.model,
    promptRole: call.prompt.role,
    promptVersion: call.prompt.version,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    let result;
    try {
      result = await llm.json({
        tag: call.tag,
        model: call.prompt.model,
        temperature: call.prompt.temperature,
        system: call.system,
        messages: [...messages],
        jsonSchema,
        maxTokens: call.maxTokens,
        thinkingLevel: call.prompt.thinkingLevel ?? undefined,
      });
    } catch (err) {
      const error =
        err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
      await callLog.log({
        ...logBase,
        latencyMs: Date.now() - started,
        status: 'error',
        error,
      });
      throw err instanceof LlmUnavailableError
        ? err
        : new LlmUnavailableError(error, err);
    }

    const parsed = call.schema.safeParse(result.output);
    const problem = parsed.success
      ? (call.check?.(parsed.data) ?? null)
      : z.prettifyError(parsed.error);
    await callLog.log({
      ...logBase,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      latencyMs: result.usage.latencyMs,
      costUsd: result.usage.costUsd,
      status: problem === null ? 'ok' : 'error',
      error: problem === null ? null : 'output failed validation',
    });
    if (parsed.success && problem === null) return parsed.data;

    messages.push(
      { role: 'assistant', content: result.raw },
      {
        role: 'user',
        content: `Your previous reply did not pass validation:\n${problem}\nReturn the corrected JSON only.`,
      },
    );
  }
  throw new LlmOutputInvalidError(call.tag);
}
