import { z } from 'zod';
import type { SttAdapter, SttResult } from './stt.adapter.js';
import { SttUnavailableError } from './stt.adapter.js';

const ENDPOINT = 'https://api.deepgram.com/v1/listen';
const MODEL = 'nova-3';
const TIMEOUT_MS = 30_000;
/** Pre-recorded Nova-3 list price, USD per audio minute. */
const USD_PER_MINUTE = 0.0043;

const responseSchema = z.object({
  metadata: z.object({ duration: z.number() }),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(
              z.object({
                transcript: z.string(),
                words: z.array(
                  z.object({
                    word: z.string(),
                    punctuated_word: z.string().optional(),
                    start: z.number(),
                    end: z.number(),
                  }),
                ),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  }),
});

export function mapDeepgramResponse(
  body: unknown,
  latencyMs: number,
): SttResult {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success)
    throw new SttUnavailableError('Deepgram returned an unexpected response');
  const alt = parsed.data.results.channels[0].alternatives[0];
  const durationS = parsed.data.metadata.duration;
  return {
    text: alt.transcript,
    words: alt.words.map((w) => ({
      w: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
    })),
    durationS,
    provider: 'deepgram',
    model: MODEL,
    latencyMs,
    costUsd: (durationS / 60) * USD_PER_MINUTE,
  };
}

export class DeepgramSttAdapter implements SttAdapter {
  readonly provider = 'deepgram';

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async transcribe(
    audio: Buffer,
    opts: { mimeType: string; language: 'en' },
  ): Promise<SttResult> {
    const params = new URLSearchParams({
      model: MODEL,
      language: opts.language,
      punctuate: 'true',
      smart_format: 'true',
      // Keeps "um"/"uh" in the transcript for the filler-word metric.
      filler_words: 'true',
    });
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchFn(`${ENDPOINT}?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': opts.mimeType,
        },
        body: new Uint8Array(audio),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SttUnavailableError('Deepgram request failed', err);
    }
    if (!res.ok)
      throw new SttUnavailableError(`Deepgram returned ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new SttUnavailableError('Deepgram returned invalid JSON', err);
    }
    return mapDeepgramResponse(body, Date.now() - started);
  }
}
