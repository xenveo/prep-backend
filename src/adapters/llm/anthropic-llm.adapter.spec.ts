import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlmAdapter, llmCostUsd } from './anthropic-llm.adapter.js';
import { LlmUnavailableError, type LlmJsonRequest } from './llm.adapter.js';

const req: LlmJsonRequest = {
  tag: 'evaluator',
  model: 'claude-sonnet-4-6',
  temperature: 0.2,
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  jsonSchema: { type: 'object', properties: { score: { type: 'number' } } },
};

function message(
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: '{"score": 72}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
    ...overrides,
  } as Anthropic.Message;
}

function adapterWith(create: ReturnType<typeof vi.fn>) {
  return new AnthropicLlmAdapter({}, {
    messages: { create },
  } as unknown as Pick<Anthropic, 'messages'>);
}

describe('AnthropicLlmAdapter', () => {
  it('maps the response, usage and cost', async () => {
    const create = vi.fn().mockResolvedValue(message());
    const result = await adapterWith(create).json(req);

    expect(result.output).toEqual({ score: 72 });
    expect(result.raw).toBe('{"score": 72}');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(200);
    expect(result.usage.costUsd).toBeCloseTo((1000 * 3 + 200 * 15) / 1e6);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the JSON schema as the output format and defaults max tokens', async () => {
    const create = vi.fn().mockResolvedValue(message());
    await adapterWith(create).json(req);
    const params = create.mock.calls[0][0];
    expect(params.output_config).toEqual({
      format: { type: 'json_schema', schema: req.jsonSchema },
    });
    expect(params.max_tokens).toBe(2000);
    expect(params.temperature).toBe(0.2);
    expect(params.system).toBe('sys');
  });

  it('omits temperature for models that reject sampling parameters', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(message({ model: 'claude-opus-5-5' }));
    await adapterWith(create).json({
      ...req,
      model: 'claude-opus-5-5',
      maxTokens: 500,
    });
    const params = create.mock.calls[0][0];
    expect(params).not.toHaveProperty('temperature');
    expect(params.max_tokens).toBe(500);
  });

  it('returns null output with the raw text when the JSON is invalid', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        message({
          content: [{ type: 'text', text: '{"score":', citations: null }],
        }),
      );
    const result = await adapterWith(create).json(req);
    expect(result.output).toBeNull();
    expect(result.raw).toBe('{"score":');
  });

  it('wraps provider errors in LlmUnavailableError', async () => {
    const create = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(adapterWith(create).json(req)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });

  it('treats a refusal as unavailable', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(message({ stop_reason: 'refusal', content: [] }));
    await expect(adapterWith(create).json(req)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });

  it('returns null cost for unknown models', () => {
    expect(llmCostUsd('some-future-model', 10, 10)).toBeNull();
  });
});
