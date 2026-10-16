// Gemini failure taxonomy shared by the LLM, STT and TTS adapters (plan 01-gemini "Error handling").
// `retryable` says whether trying again can help: a timeout, a per-minute 429 or a 5xx can; a bad
// request, a missing model, a per-day quota, truncation or a content block cannot. Adapters wrap
// these in their own *UnavailableError.

export type GeminiErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'unavailable'
  | 'model_not_found'
  | 'bad_request'
  | 'forbidden'
  | 'max_tokens'
  | 'blocked'
  | 'empty'
  | 'unknown';

export class GeminiError extends Error {
  constructor(
    readonly code: GeminiErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/** Maps an SDK or network error. `timedOut` is set when our own deadline aborted the call. */
export function toGeminiError(err: unknown, timedOut = false): GeminiError {
  if (err instanceof GeminiError) return err;
  const e = (err ?? {}) as {
    name?: unknown;
    status?: unknown;
    message?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message : String(err);

  if (timedOut || e.name === 'AbortError')
    return new GeminiError('timeout', 'Gemini did not respond in time', true);

  const status = typeof e.status === 'number' ? e.status : null;
  const detail = `Gemini ${status ?? 'error'}: ${apiMessage(message)}`;
  if (status === 429) {
    // A per-minute limit clears within a retry; a per-day quota does not clear for hours.
    return /PerDay|per day/i.test(message)
      ? new GeminiError('quota_exhausted', detail, false, status)
      : new GeminiError('rate_limited', detail, true, status);
  }
  if (status !== null && status >= 500)
    return new GeminiError('unavailable', detail, true, status);
  if (status === 404)
    return new GeminiError('model_not_found', detail, false, status);
  if (status === 401 || status === 403)
    return new GeminiError('forbidden', detail, false, status);
  if (status !== null && status >= 400)
    return new GeminiError('bad_request', detail, false, status);
  return new GeminiError('unknown', detail, true, status);
}

/** The SDK's ApiError message is the JSON error body; keep only its human message, shortened. */
function apiMessage(message: string): string {
  let text = message;
  try {
    const body = JSON.parse(message) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') text = body.error.message;
  } catch {
    // Not JSON (network errors): use it as is.
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
