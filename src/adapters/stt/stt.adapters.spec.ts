import {
  DeepgramSttAdapter,
  mapDeepgramResponse,
} from './deepgram-stt.adapter.js';
import { FAKE_STT_DEFAULT_ANSWER, FakeSttAdapter } from './fake-stt.adapter.js';
import { SttUnavailableError } from './stt.adapter.js';

const deepgramBody = {
  metadata: { duration: 3.2 },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'Um, hello there.',
            words: [
              { word: 'um', punctuated_word: 'Um,', start: 0.1, end: 0.3 },
              { word: 'hello', punctuated_word: 'hello', start: 0.5, end: 0.9 },
              { word: 'there', punctuated_word: 'there.', start: 1, end: 1.4 },
            ],
          },
        ],
      },
    ],
  },
};

describe('FakeSttAdapter', () => {
  const stt = new FakeSttAdapter();

  it('uses the text after FAKE: as the transcript', async () => {
    const r = await stt.transcribe(Buffer.from('FAKE: I led the project'), {
      mimeType: 'audio/webm',
      language: 'en',
    });
    expect(r.text).toBe('I led the project');
    expect(r.words.map((w) => w.w)).toEqual(['I', 'led', 'the', 'project']);
  });

  it('falls back to a fixed answer with fillers, ~150 wpm and one 1.5 s pause', async () => {
    const r = await stt.transcribe(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), {
      mimeType: 'audio/webm',
      language: 'en',
    });
    expect(r.text).toBe(FAKE_STT_DEFAULT_ANSWER);
    expect(r.words.length).toBeGreaterThan(50);
    expect(r.words.filter((w) => /^(um|uh)[,.]?$/i.test(w.w))).toHaveLength(2);
    const gaps = r.words.slice(1).map((w, i) => w.start - r.words[i].end);
    expect(gaps.filter((g) => g >= 1.5 - 1e-9)).toHaveLength(1);
    expect(r.durationS).toBe(r.words[r.words.length - 1].end);
    const wpm = r.words.length / ((r.durationS - 1.5) / 60);
    expect(wpm).toBeCloseTo(150, 0);
  });

  it('is deterministic', async () => {
    const a = await stt.transcribe(Buffer.from('x'), {
      mimeType: 'audio/webm',
      language: 'en',
    });
    const b = await stt.transcribe(Buffer.from('x'), {
      mimeType: 'audio/webm',
      language: 'en',
    });
    expect(a).toEqual(b);
  });
});

describe('DeepgramSttAdapter', () => {
  it('maps words, duration and cost', () => {
    const r = mapDeepgramResponse(deepgramBody, 42);
    expect(r.text).toBe('Um, hello there.');
    expect(r.words[0]).toEqual({ w: 'Um,', start: 0.1, end: 0.3 });
    expect(r.durationS).toBe(3.2);
    expect(r.latencyMs).toBe(42);
    expect(r.model).toBe('nova-3');
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('requests filler words and sends the audio', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(deepgramBody), { status: 200 }),
      );
    const stt = new DeepgramSttAdapter(
      'key',
      fetchFn as unknown as typeof fetch,
    );
    await stt.transcribe(Buffer.from('abc'), {
      mimeType: 'audio/webm',
      language: 'en',
    });
    const [url, init] = fetchFn.mock.calls[0];
    const params = new URL(url as string).searchParams;
    expect(params.get('filler_words')).toBe('true');
    expect(params.get('model')).toBe('nova-3');
    expect(init.headers.Authorization).toBe('Token key');
    expect(init.headers['Content-Type']).toBe('audio/webm');
  });

  it('maps HTTP errors and network failures to SttUnavailableError', async () => {
    const bad = new DeepgramSttAdapter(
      'k',
      vi
        .fn()
        .mockResolvedValue(
          new Response('no', { status: 503 }),
        ) as unknown as typeof fetch,
    );
    await expect(
      bad.transcribe(Buffer.from('a'), {
        mimeType: 'audio/webm',
        language: 'en',
      }),
    ).rejects.toBeInstanceOf(SttUnavailableError);
    const down = new DeepgramSttAdapter(
      'k',
      vi
        .fn()
        .mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch,
    );
    await expect(
      down.transcribe(Buffer.from('a'), {
        mimeType: 'audio/webm',
        language: 'en',
      }),
    ).rejects.toBeInstanceOf(SttUnavailableError);
  });

  it('rejects malformed bodies', () => {
    expect(() => mapDeepgramResponse({ results: {} }, 1)).toThrow(
      SttUnavailableError,
    );
  });
});
