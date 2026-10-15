import type { SttAdapter, SttResult, SttWord } from './stt.adapter.js';

const FAKE_PREFIX = 'FAKE:';
const SECONDS_PER_WORD = 60 / 150;
const PAUSE_S = 1.5;

export const FAKE_STT_DEFAULT_ANSWER =
  'In my last job a customer called because her order was late for the second time. ' +
  'Um, I listened to the whole story first and told her I could see why she was frustrated. ' +
  'I checked the tracking, found the parcel stuck at the depot, and uh arranged a courier for the next morning. ' +
  'I called her back the next day and she thanked me for staying with it.';

/** Deterministic word timings at ~150 wpm, with one 1.5 s pause in the middle. */
export function fakeWordTimings(text: string): SttWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const pauseAfter = Math.floor(tokens.length / 2);
  const words: SttWord[] = [];
  let t = 0;
  tokens.forEach((w, i) => {
    const start = round(t);
    t += SECONDS_PER_WORD;
    words.push({ w, start, end: round(t) });
    if (i + 1 === pauseAfter) t += PAUSE_S;
  });
  return words;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Test and dev STT. A buffer of UTF-8 text starting with `FAKE:` is used as the transcript. */
export class FakeSttAdapter implements SttAdapter {
  readonly provider = 'fake';

  transcribe(
    audio: Buffer,
    _opts?: { mimeType: string; language: 'en' },
  ): Promise<SttResult> {
    const head = audio.subarray(0, FAKE_PREFIX.length).toString('utf8');
    const text =
      head === FAKE_PREFIX
        ? audio.subarray(FAKE_PREFIX.length).toString('utf8').trim()
        : FAKE_STT_DEFAULT_ANSWER;
    const words = fakeWordTimings(text);
    return Promise.resolve({
      text,
      words,
      durationS: words.length ? words[words.length - 1].end : 0,
      provider: this.provider,
      model: null,
      latencyMs: 0,
      costUsd: null,
    });
  }
}
