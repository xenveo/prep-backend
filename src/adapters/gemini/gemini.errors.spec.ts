import { ApiError } from '@google/genai';
import { GeminiError, toGeminiError } from './gemini.errors.js';

const api = (status: number, message = 'nope', extra = '') =>
  new ApiError({
    status,
    message: JSON.stringify({ error: { code: status, message, extra } }),
  });

describe('toGeminiError', () => {
  it.each([
    ['per-minute 429', api(429, 'Resource exhausted'), 'rate_limited', true],
    [
      'per-day 429',
      api(429, 'Quota exceeded', 'GenerateRequestsPerDayPerProjectPerModel'),
      'quota_exhausted',
      false,
    ],
    ['500', api(500), 'unavailable', true],
    ['503', api(503), 'unavailable', true],
    ['400', api(400), 'bad_request', false],
    ['401', api(401), 'forbidden', false],
    ['403', api(403), 'forbidden', false],
    ['404', api(404), 'model_not_found', false],
    ['network failure', new TypeError('fetch failed'), 'unknown', true],
  ] as const)('maps a %s', (_, err, code, retryable) => {
    expect(toGeminiError(err)).toMatchObject({ code, retryable });
  });

  it('maps our own deadline and an AbortError to a retryable timeout', () => {
    expect(toGeminiError(new Error('whatever'), true)).toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toGeminiError(abort)).toMatchObject({ code: 'timeout' });
  });

  it('keeps only the API message from the JSON body', () => {
    const err = toGeminiError(api(404, 'models/x is not found'));
    expect(err.message).toBe('Gemini 404: models/x is not found');
    expect(err.status).toBe(404);
  });

  it('passes a GeminiError through', () => {
    const err = new GeminiError('max_tokens', 'cut', false);
    expect(toGeminiError(err)).toBe(err);
  });
});
