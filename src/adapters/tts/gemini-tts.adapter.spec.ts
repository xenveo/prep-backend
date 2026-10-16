import type { Env } from '../../config/env.js';
import { createTtsAdapter } from '../adapters.module.js';
import type { GeminiClient } from '../gemini/gemini.client.js';
import { ElevenLabsTtsAdapter } from './elevenlabs-tts.adapter.js';
import { FakeTtsAdapter } from './fake-tts.adapter.js';
import { GeminiError } from '../gemini/gemini.errors.js';
import {
  GEMINI_VOICES,
  GeminiTtsAdapter,
  wavDurationS,
} from './gemini-tts.adapter.js';
import { TtsUnavailableError } from './tts.adapter.js';

/** A PCM WAV like the API returns: 24 kHz, mono, 16-bit, so 48,000 bytes a second. */
function wav(seconds: number, extraChunk = false): Buffer {
  const dataBytes = Math.round(seconds * 48_000);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(24_000, 12);
  fmt.writeUInt32LE(48_000, 16); // byte rate
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = Buffer.alloc(extraChunk ? 13 : 0);
  if (extraChunk) {
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(5, 4); // odd size: padded to 6
  }
  const pad = Buffer.alloc(extraChunk ? 1 : 0);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(dataBytes, 4);
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    fmt,
    list,
    pad,
    dataHeader,
    Buffer.alloc(dataBytes),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const usage = {
  inputTokens: 17,
  outputTokens: 114,
  latencyMs: 3600,
  costUsd: 0.00103,
};

function response(audio: Buffer | null) {
  return {
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: audio
              ? [
                  {
                    inlineData: {
                      mimeType: 'audio/wav',
                      data: audio.toString('base64'),
                    },
                  },
                ]
              : [{ text: 'no audio' }],
          },
        },
      ],
    },
    usage,
  };
}

function setup(result: unknown) {
  const generate =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  const adapter = new GeminiTtsAdapter(
    { generate } as unknown as GeminiClient,
    'gemini-3.8-flash-tts',
  );
  return { adapter, generate };
}

describe('wavDurationS', () => {
  it('divides the data size by the byte rate', () => {
    expect(wavDurationS(wav(2.5))).toBe(2.5);
  });

  it('skips other chunks, padding odd sizes', () => {
    expect(wavDurationS(wav(1, true))).toBe(1);
  });

  it('clamps a placeholder data size to the bytes present', () => {
    const buf = wav(1);
    buf.writeUInt32LE(0xffffffff, 40);
    expect(wavDurationS(buf)).toBe(1);
  });

  it('returns null for anything that is not a WAV', () => {
    expect(wavDurationS(Buffer.from('ID3 not a wav file'))).toBeNull();
    expect(wavDurationS(Buffer.alloc(4))).toBeNull();
    expect(wavDurationS(wav(1).subarray(0, 20))).toBeNull();
  });
});

describe('GeminiTtsAdapter', () => {
  it('declares WAV output', () => {
    expect(setup(response(wav(1))).adapter.mimeType).toBe('audio/wav');
  });

  it('sends the text as the only part, with audio output and the mapped prebuilt voice', async () => {
    const { adapter, generate } = setup(response(wav(1)));
    await adapter.speak('Tell me about yourself.', 'Warm, lower pitch');
    expect(generate).toHaveBeenCalledWith({
      model: 'gemini-3.8-flash-tts',
      contents: [
        { role: 'user', parts: [{ text: 'Tell me about yourself.' }] },
      ],
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'charon' } },
      },
    });
  });

  it.each([
    ['Calm, mid-pitch', 'en-in-podcaster-7'],
    ['Warm, lower pitch', 'charon'],
    ['Bright, higher pitch', 'en-in-tutor-11'],
    ['Robot', 'en-in-podcaster-7'],
  ])('maps the label %s to %s', async (label, voiceName) => {
    const { adapter, generate } = setup(response(wav(1)));
    await adapter.speak('Hi', label);
    expect(generate.mock.calls[0][0]).toMatchObject({
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    });
  });

  it('has a voice for each workspace voice label', () => {
    expect(Object.keys(GEMINI_VOICES)).toEqual([
      'Calm, mid-pitch',
      'Warm, lower pitch',
      'Bright, higher pitch',
    ]);
  });

  it('returns the WAV bytes unchanged, with the header duration and usage', async () => {
    const audio = wav(4.68);
    const { adapter } = setup(response(audio));
    expect(await adapter.speak('Hi', 'Calm, mid-pitch')).toEqual({
      audio,
      mimeType: 'audio/wav',
      durationS: 4.7,
      provider: 'gemini',
      latencyMs: 3600,
      costUsd: 0.00103,
    });
  });

  it('maps client failures to TtsUnavailableError with the Gemini code', async () => {
    const cause = new GeminiError('quota_exhausted', 'Gemini 429', false, 429);
    const { adapter } = setup(cause);
    const err = await adapter.speak('Hi', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsUnavailableError);
    expect((err as TtsUnavailableError).message).toContain('quota_exhausted');
    expect((err as TtsUnavailableError).cause).toBe(cause);
  });

  it('maps unexpected errors to TtsUnavailableError', async () => {
    const { adapter } = setup(new Error('socket hang up'));
    await expect(adapter.speak('Hi', 'x')).rejects.toBeInstanceOf(
      TtsUnavailableError,
    );
  });

  it('rejects a response without audio', async () => {
    const { adapter } = setup(response(null));
    await expect(adapter.speak('Hi', 'x')).rejects.toThrow(
      'Gemini returned no audio',
    );
  });

  it('rejects audio that is not WAV (e.g. headerless L16)', async () => {
    const { adapter } = setup(response(Buffer.alloc(4800)));
    await expect(adapter.speak('Hi', 'x')).rejects.toThrow('not WAV');
  });
});

describe('createTtsAdapter', () => {
  const gemini = {} as GeminiClient;
  const env = (over: Partial<Env>) => over as Env;

  it('requires GEMINI_API_KEY for the gemini provider', () => {
    expect(() =>
      createTtsAdapter(env({ TTS_PROVIDER: 'gemini' }), gemini),
    ).toThrow('GEMINI_API_KEY is required');
  });

  it('builds each provider', () => {
    expect(
      createTtsAdapter(
        env({ TTS_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }),
        gemini,
      ),
    ).toBeInstanceOf(GeminiTtsAdapter);
    expect(
      createTtsAdapter(
        env({ TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k' }),
        gemini,
      ),
    ).toBeInstanceOf(ElevenLabsTtsAdapter);
    expect(
      createTtsAdapter(env({ TTS_PROVIDER: 'fake' }), gemini),
    ).toBeInstanceOf(FakeTtsAdapter);
  });
});
