import {
  ELEVENLABS_VOICES,
  ElevenLabsTtsAdapter,
} from './elevenlabs-tts.adapter.js';
import { FakeTtsAdapter } from './fake-tts.adapter.js';
import { estimateSpeechSeconds } from './tts-duration.js';
import { TtsUnavailableError } from './tts.adapter.js';

describe('estimateSpeechSeconds', () => {
  it('assumes ~150 words a minute', () => {
    expect(estimateSpeechSeconds(Array(150).fill('word').join(' '))).toBe(60);
    expect(estimateSpeechSeconds('')).toBe(0);
  });
});

describe('FakeTtsAdapter', () => {
  it('returns a small mp3 and a word-count duration', async () => {
    const r = await new FakeTtsAdapter().speak(
      'one two three four five',
      'Calm, mid-pitch',
    );
    expect(r.mimeType).toBe('audio/mpeg');
    expect(r.audio[0]).toBe(0xff);
    expect(r.audio.length).toBeGreaterThan(0);
    expect(r.durationS).toBe(2);
  });
});

describe('ElevenLabsTtsAdapter', () => {
  it('maps the voice label to a provider voice id', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );
    const tts = new ElevenLabsTtsAdapter(
      'key',
      fetchFn as unknown as typeof fetch,
    );
    const r = await tts.speak('Hello there', 'Warm, lower pitch');
    expect(fetchFn.mock.calls[0][0]).toContain(
      `/${ELEVENLABS_VOICES['Warm, lower pitch']}?`,
    );
    expect(fetchFn.mock.calls[0][1].headers['xi-api-key']).toBe('key');
    expect(r.audio).toEqual(Buffer.from([1, 2, 3]));
    expect(r.durationS).toBeGreaterThan(0);
  });

  it('falls back to the default voice for unknown labels', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    await new ElevenLabsTtsAdapter(
      'key',
      fetchFn as unknown as typeof fetch,
    ).speak('Hi', 'Unknown');
    expect(fetchFn.mock.calls[0][0]).toContain(
      ELEVENLABS_VOICES['Calm, mid-pitch'],
    );
  });

  it('throws TtsUnavailableError on provider errors', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('x', { status: 500 }));
    await expect(
      new ElevenLabsTtsAdapter('k', fetchFn as unknown as typeof fetch).speak(
        'Hi',
        'x',
      ),
    ).rejects.toBeInstanceOf(TtsUnavailableError);
  });
});
