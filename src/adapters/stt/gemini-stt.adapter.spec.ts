import type { Env } from '../../config/env.js';
import { createSttAdapter } from '../adapters.module.js';
import type { GeminiClient } from '../gemini/gemini.client.js';
import { DeepgramSttAdapter } from './deepgram-stt.adapter.js';
import { FakeSttAdapter } from './fake-stt.adapter.js';
import { GeminiError } from '../gemini/gemini.errors.js';
import {
  GEMINI_STT_JSON_SCHEMA,
  GEMINI_STT_SYSTEM,
  GeminiSttAdapter,
} from './gemini-stt.adapter.js';
import { SttUnavailableError } from './stt.adapter.js';

const usage = {
  inputTokens: 600,
  outputTokens: 80,
  latencyMs: 3200,
  costUsd: 0.00075,
};
const opts = { mimeType: 'audio/webm', language: 'en' as const };

function setup(result: unknown) {
  const generateJson =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  const adapter = new GeminiSttAdapter(
    { generateJson } as unknown as GeminiClient,
    'gemini-3.8-flash',
  );
  return { adapter, generateJson };
}

describe('GeminiSttAdapter', () => {
  it('sends the audio inline with its mime type, the verbatim instruction, the schema, temperature 0 and thinking low', async () => {
    const { adapter, generateJson } = setup({ text: '{"text":"Hi"}', usage });
    await adapter.transcribe(Buffer.from('opus bytes'), opts);
    expect(generateJson).toHaveBeenCalledWith({
      model: 'gemini-3.8-flash',
      systemInstruction: GEMINI_STT_SYSTEM,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/webm',
                data: Buffer.from('opus bytes').toString('base64'),
              },
            },
            { text: 'Transcribe this answer.' },
          ],
        },
      ],
      jsonSchema: GEMINI_STT_JSON_SCHEMA,
      temperature: 0,
      maxOutputTokens: 8192,
      thinkingLevel: 'low',
    });
  });

  it('passes the upload mime type through unchanged', async () => {
    const { adapter, generateJson } = setup({ text: '{"text":"Hi"}', usage });
    await adapter.transcribe(Buffer.from('a'), {
      ...opts,
      mimeType: 'audio/mp4',
    });
    const req = generateJson.mock.calls[0][0] as {
      contents: { parts: { inlineData?: { mimeType: string } }[] }[];
    };
    expect(req.contents[0].parts[0].inlineData?.mimeType).toBe('audio/mp4');
  });

  it('keeps fillers in the instruction and asks for text only', () => {
    expect(GEMINI_STT_SYSTEM).toContain('um, uh, like, you know');
    expect(GEMINI_STT_SYSTEM).not.toMatch(/timestamp|start and end|silence/i);
    expect(GEMINI_STT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(Object.keys(GEMINI_STT_JSON_SCHEMA.properties as object)).toEqual([
      'text',
    ]);
  });

  it('returns the transcript with no words, an unmeasured duration, and usage', async () => {
    const { adapter } = setup({
      text: '{"text":"  Um, I led the, the project. "}',
      usage,
    });
    expect(await adapter.transcribe(Buffer.from('a'), opts)).toEqual({
      text: 'Um, I led the, the project.',
      words: [],
      durationS: 0,
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      latencyMs: 3200,
      costUsd: 0.00075,
    });
  });

  it('maps client failures to SttUnavailableError with the Gemini code', async () => {
    const cause = new GeminiError('rate_limited', 'Gemini 429', true, 429);
    const { adapter } = setup(cause);
    const err = await adapter
      .transcribe(Buffer.from('a'), opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttUnavailableError);
    expect((err as SttUnavailableError).message).toContain('rate_limited');
    expect((err as SttUnavailableError).cause).toBe(cause);
  });

  it('maps unexpected errors to SttUnavailableError', async () => {
    const { adapter } = setup(new Error('socket hang up'));
    await expect(
      adapter.transcribe(Buffer.from('a'), opts),
    ).rejects.toBeInstanceOf(SttUnavailableError);
  });

  it.each([
    ['invalid JSON', '{"text":'],
    ['a wrong shape', '{"transcript":"Hi"}'],
  ])('rejects %s with SttUnavailableError', async (_label, text) => {
    const { adapter } = setup({ text, usage });
    await expect(
      adapter.transcribe(Buffer.from('a'), opts),
    ).rejects.toBeInstanceOf(SttUnavailableError);
  });
});

describe('createSttAdapter', () => {
  const gemini = {} as GeminiClient;
  const env = (over: Partial<Env>) => over as Env;

  it('requires GEMINI_API_KEY for the gemini provider', () => {
    expect(() =>
      createSttAdapter(env({ STT_PROVIDER: 'gemini' }), gemini),
    ).toThrow('GEMINI_API_KEY is required');
  });

  it('builds each provider', () => {
    expect(
      createSttAdapter(
        env({ STT_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }),
        gemini,
      ),
    ).toBeInstanceOf(GeminiSttAdapter);
    expect(
      createSttAdapter(
        env({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'k' }),
        gemini,
      ),
    ).toBeInstanceOf(DeepgramSttAdapter);
    expect(
      createSttAdapter(env({ STT_PROVIDER: 'fake' }), gemini),
    ).toBeInstanceOf(FakeSttAdapter);
  });
});
