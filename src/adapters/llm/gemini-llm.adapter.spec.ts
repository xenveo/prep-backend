import type { Env } from '../../config/env.js';
import { createLlmAdapter } from '../adapters.module.js';
import type { GeminiClient } from '../gemini/gemini.client.js';
import { GeminiError } from '../gemini/gemini.errors.js';
import { AnthropicLlmAdapter } from './anthropic-llm.adapter.js';
import { FakeLlmAdapter } from './fake-llm.adapter.js';
import { GeminiLlmAdapter } from './gemini-llm.adapter.js';
import { LlmUnavailableError, type LlmJsonRequest } from './llm.adapter.js';

const req: LlmJsonRequest = {
  tag: 'evaluator',
  model: 'gemini-3.8-flash',
  temperature: 0.2,
  system: 'sys',
  messages: [
    { role: 'user', content: 'answer' },
    { role: 'assistant', content: '{"bad":' },
    { role: 'user', content: 'fix it' },
  ],
  jsonSchema: { $schema: 'x', type: 'object' },
  thinkingLevel: 'low',
};

const usage = {
  inputTokens: 1000,
  outputTokens: 250,
  latencyMs: 12,
  costUsd: 0.0017,
};

function setup(result: unknown) {
  const generateJson =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  const adapter = new GeminiLlmAdapter({
    generateJson,
  } as unknown as GeminiClient);
  return { adapter, generateJson };
}

describe('GeminiLlmAdapter', () => {
  it('maps system, turns (assistant → model), schema, temperature and thinking', async () => {
    const { adapter, generateJson } = setup({ text: '{"a":1}', usage });
    await adapter.json(req);
    expect(generateJson).toHaveBeenCalledWith({
      model: 'gemini-3.8-flash',
      systemInstruction: 'sys',
      contents: [
        { role: 'user', parts: [{ text: 'answer' }] },
        { role: 'model', parts: [{ text: '{"bad":' }] },
        { role: 'user', parts: [{ text: 'fix it' }] },
      ],
      jsonSchema: req.jsonSchema,
      temperature: 0.2,
      maxOutputTokens: 16_384,
      thinkingLevel: 'low',
    });
  });

  it('passes maxTokens and an omitted thinking level through', async () => {
    const { adapter, generateJson } = setup({ text: '{}', usage });
    await adapter.json({ ...req, maxTokens: 500, thinkingLevel: undefined });
    expect(generateJson.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: 500,
      thinkingLevel: undefined,
    });
  });

  it('returns the parsed output, raw text and usage', async () => {
    const { adapter } = setup({ text: '{"score":4}', usage });
    expect(await adapter.json(req)).toEqual({
      output: { score: 4 },
      raw: '{"score":4}',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      usage,
    });
  });

  it('returns null output with the raw text when the JSON is invalid', async () => {
    const { adapter } = setup({ text: '{"score":', usage });
    const result = await adapter.json(req);
    expect(result.output).toBeNull();
    expect(result.raw).toBe('{"score":');
  });

  it.each([
    new GeminiError('rate_limited', 'slow', true, 429),
    new GeminiError('max_tokens', 'cut', false),
    new Error('boom'),
  ])('wraps %s in LlmUnavailableError', async (err) => {
    const { adapter } = setup(err);
    const thrown = await adapter.json(req).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(LlmUnavailableError);
    expect((thrown as LlmUnavailableError).cause).toBe(err);
  });
});

describe('createLlmAdapter', () => {
  const gemini = {} as GeminiClient;
  const env = (over: Partial<Env>) => over as Env;

  it('requires GEMINI_API_KEY for the gemini provider', () => {
    expect(() =>
      createLlmAdapter(env({ LLM_PROVIDER: 'gemini' }), gemini),
    ).toThrow('GEMINI_API_KEY is required');
  });

  it('builds each provider', () => {
    expect(
      createLlmAdapter(
        env({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }),
        gemini,
      ),
    ).toBeInstanceOf(GeminiLlmAdapter);
    expect(
      createLlmAdapter(
        env({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }),
        gemini,
      ),
    ).toBeInstanceOf(AnthropicLlmAdapter);
    expect(
      createLlmAdapter(env({ LLM_PROVIDER: 'fake' }), gemini),
    ).toBeInstanceOf(FakeLlmAdapter);
  });
});
