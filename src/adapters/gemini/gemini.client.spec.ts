import {
  ApiError,
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  ThinkingLevel,
} from '@google/genai';
import { Logger } from '@nestjs/common';
import {
  draftQuestionsOutputSchema,
  evaluatorOutputSchema,
  jsonSchemaOf,
  summariserOutputSchema,
} from '../../modules/ai/schemas.js';
import {
  GeminiClient,
  toGeminiJsonSchema,
  type GeminiModelsApi,
  type GeminiRequest,
} from './gemini.client.js';
import { geminiCostUsd } from './gemini.pricing.js';

function response(
  over: Partial<GenerateContentResponse> & { text?: string } = {},
): GenerateContentResponse {
  const { text = '{"ok":true}', ...rest } = over;
  return Object.assign(new GenerateContentResponse(), {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: FinishReason.STOP,
      },
    ],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 50,
    },
    ...rest,
  });
}

function setup(generated: unknown = response(), timeoutMs = 30_000) {
  const models = {
    get: vi.fn().mockResolvedValue({ name: 'models/gemini-3.8-flash' }),
    generateContent:
      typeof generated === 'function'
        ? vi.fn(generated as () => unknown)
        : generated instanceof Error
          ? vi.fn().mockRejectedValue(generated)
          : vi.fn().mockResolvedValue(generated),
  };
  const client = new GeminiClient(
    { apiKey: 'k', timeoutMs },
    models as unknown as GeminiModelsApi,
  );
  return { client, models };
}

const req: GeminiRequest = {
  model: 'gemini-3.8-flash',
  systemInstruction: 'sys',
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  temperature: 0.2,
  maxOutputTokens: 4096,
};
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
};

describe('GeminiClient', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('ensureModel', () => {
    it('checks each model once', async () => {
      const { client, models } = setup();
      await client.ensureModel('a');
      await client.ensureModel('a');
      await client.ensureModel('b');
      expect(models.get).toHaveBeenCalledTimes(2);
      expect(models.get.mock.calls[0][0]).toMatchObject({ model: 'a' });
    });

    it('drops a failed check so the next call retries', async () => {
      const { client, models } = setup();
      models.get
        .mockRejectedValueOnce(new ApiError({ status: 503, message: 'down' }))
        .mockResolvedValueOnce({});
      await expect(client.ensureModel('a')).rejects.toMatchObject({
        code: 'unavailable',
        retryable: true,
      });
      await expect(client.ensureModel('a')).resolves.toBeUndefined();
      expect(models.get).toHaveBeenCalledTimes(2);
    });

    it('rejects a missing model as definitive', async () => {
      const { client, models } = setup();
      models.get.mockRejectedValue(
        new ApiError({ status: 404, message: 'not found' }),
      );
      await expect(client.ensureModel('nope')).rejects.toMatchObject({
        code: 'model_not_found',
        retryable: false,
      });
    });

    it('rejects without an API key instead of calling the SDK', async () => {
      const client = new GeminiClient({ timeoutMs: 1000 });
      await expect(client.ensureModel('a')).rejects.toMatchObject({
        code: 'forbidden',
        retryable: false,
      });
    });
  });

  describe('generate', () => {
    it('maps the request, with the deadline signal and no thinking by default', async () => {
      const { client, models } = setup();
      await client.generate(req);
      const params = models.generateContent.mock.calls[0][0];
      expect(params.model).toBe('gemini-3.8-flash');
      expect(params.contents).toEqual(req.contents);
      expect(params.config).toEqual({
        abortSignal: expect.any(AbortSignal),
        systemInstruction: 'sys',
        temperature: 0.2,
        maxOutputTokens: 4096,
      });
    });

    it.each([
      ['low', ThinkingLevel.LOW],
      ['medium', ThinkingLevel.MEDIUM],
      ['high', ThinkingLevel.HIGH],
    ] as const)('maps thinking level %s', async (level, sdk) => {
      const { client, models } = setup();
      await client.generate({ ...req, thinkingLevel: level });
      expect(
        models.generateContent.mock.calls[0][0].config.thinkingConfig,
      ).toEqual({ thinkingLevel: sdk });
    });

    it('sends JSON output as responseJsonSchema only, stripped', async () => {
      const { client, models } = setup();
      await client.generate({ ...req, jsonSchema: schema });
      const { config } = models.generateContent.mock.calls[0][0];
      expect(config.responseMimeType).toBe('application/json');
      expect(config.responseJsonSchema).toEqual({ type: 'object' });
      expect(config).not.toHaveProperty('responseSchema');
    });

    it('passes TTS modalities and speech config through', async () => {
      const { client, models } = setup();
      const speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'aoede' } },
      };
      await client.generate({
        ...req,
        responseModalities: ['AUDIO'],
        speechConfig,
      });
      expect(models.generateContent.mock.calls[0][0].config).toMatchObject({
        responseModalities: ['AUDIO'],
        speechConfig,
      });
    });

    it('reports usage with thinking billed as output, and its cost', async () => {
      const { client } = setup();
      const { usage } = await client.generate(req);
      expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 250 });
      expect(usage.costUsd).toBe(geminiCostUsd('gemini-3.8-flash', 1000, 250));
      expect(usage.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('checks the model before generating', async () => {
      const { client, models } = setup();
      models.get.mockRejectedValue(new ApiError({ status: 404, message: 'x' }));
      await expect(client.generate(req)).rejects.toMatchObject({
        code: 'model_not_found',
      });
      expect(models.generateContent).not.toHaveBeenCalled();
    });

    it.each([
      [FinishReason.MAX_TOKENS, 'max_tokens'],
      [FinishReason.SAFETY, 'blocked'],
      [FinishReason.PROHIBITED_CONTENT, 'blocked'],
    ])(
      'rejects finishReason %s as non-retryable %s, though text came back',
      async (finishReason, code) => {
        const res = response({ text: '{"cut":' });
        res.candidates![0].finishReason = finishReason;
        const { client } = setup(res);
        await expect(client.generate(req)).rejects.toMatchObject({
          code,
          retryable: false,
        });
      },
    );

    it('rejects a blocked prompt as non-retryable', async () => {
      const { client } = setup(
        response({
          candidates: [],
          promptFeedback: { blockReason: BlockedReason.SAFETY },
        }),
      );
      await expect(client.generate(req)).rejects.toMatchObject({
        code: 'blocked',
        retryable: false,
      });
    });

    it('maps API errors', async () => {
      const { client } = setup(
        new ApiError({ status: 429, message: 'slow down' }),
      );
      await expect(client.generate(req)).rejects.toMatchObject({
        code: 'rate_limited',
        retryable: true,
      });
    });

    it('aborts at the deadline as a retryable timeout', async () => {
      const { client } = setup(
        ({ config }: { config: { abortSignal: AbortSignal } }) =>
          new Promise((_, reject) =>
            config.abortSignal.addEventListener('abort', () =>
              reject(new Error('This operation was aborted')),
            ),
          ),
        10,
      );
      await expect(client.generate(req)).rejects.toMatchObject({
        code: 'timeout',
        retryable: true,
      });
    });
  });

  describe('generateJson', () => {
    it('returns the text', async () => {
      const { client } = setup();
      const result = await client.generateJson({ ...req, jsonSchema: schema });
      expect(result.text).toBe('{"ok":true}');
    });

    it('rejects an empty response as retryable', async () => {
      const { client } = setup(
        response({
          candidates: [
            { content: { parts: [] }, finishReason: FinishReason.STOP },
          ],
        }),
      );
      await expect(
        client.generateJson({ ...req, jsonSchema: schema }),
      ).rejects.toMatchObject({ code: 'empty', retryable: true });
    });
  });
});

describe('toGeminiJsonSchema', () => {
  it('strips $schema at any depth and keeps everything else', () => {
    expect(
      toGeminiJsonSchema({
        $schema: 'x',
        type: 'object',
        properties: { a: { $schema: 'y', anyOf: [{ type: 'null' }] } },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { anyOf: [{ type: 'null' }] } },
    });
  });

  // Every keyword these emit was accepted by gemini-3.8-flash in the P0 spike and the G-LLM smoke call.
  const ACCEPTED = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'anyOf',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
  ]);
  it.each([
    ['evaluator', evaluatorOutputSchema],
    ['summariser', summariserOutputSchema],
    ['drafter', draftQuestionsOutputSchema],
  ])('leaves only accepted keywords in the %s schema', (_, zodSchema) => {
    const keys = new Set<string>();
    const walk = (v: unknown, inProperties = false): void => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x));
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if (!inProperties) keys.add(k);
        walk(x, !inProperties && k === 'properties');
      }
    };
    walk(toGeminiJsonSchema(jsonSchemaOf(zodSchema)));
    expect([...keys].filter((k) => !ACCEPTED.has(k))).toEqual([]);
  });
});
