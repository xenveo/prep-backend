import { z } from 'zod';
import type { GeminiClient } from '../gemini/gemini.client.js';
import { GeminiError } from '../gemini/gemini.errors.js';
import type { SttAdapter, SttResult } from './stt.adapter.js';
import { SttUnavailableError } from './stt.adapter.js';

/** P0's instruction, minus the timing request: pauses are measured in the browser (decision 1a). */
export const GEMINI_STT_SYSTEM =
  'You transcribe English speech for an interview-practice app. Transcribe verbatim: keep filler ' +
  'words (um, uh, like, you know) and repetitions exactly as spoken, and do not correct grammar. ' +
  'Return only JSON matching the schema.';

const outputSchema = z.object({ text: z.string() });
export const GEMINI_STT_JSON_SCHEMA = z.toJSONSchema(outputSchema, {
  io: 'output',
}) as Record<string, unknown>;

/** Compact transcripts of 2-min answers stay far below this. */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * gemini-3.8-flash transcription of uploaded answers (plan 01-gemini "STT adapter"). It returns
 * text only: no word timings, and `durationS` is 0 (unmeasured), so the pipeline uses the
 * client-sent duration and the browser's pause metrics.
 */
export class GeminiSttAdapter implements SttAdapter {
  readonly provider = 'gemini';

  constructor(
    private readonly gemini: GeminiClient,
    private readonly model: string,
  ) {}

  async transcribe(
    audio: Buffer,
    opts: { mimeType: string; language: 'en' },
  ): Promise<SttResult> {
    let result;
    try {
      result = await this.gemini.generateJson({
        model: this.model,
        systemInstruction: GEMINI_STT_SYSTEM,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: opts.mimeType,
                  data: audio.toString('base64'),
                },
              },
              { text: 'Transcribe this answer.' },
            ],
          },
        ],
        jsonSchema: GEMINI_STT_JSON_SCHEMA,
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingLevel: 'low',
      });
    } catch (err) {
      const code = err instanceof GeminiError ? err.code : 'unknown';
      throw new SttUnavailableError(
        `Gemini transcription failed: ${code}`,
        err,
      );
    }

    let parsed;
    try {
      parsed = outputSchema.safeParse(JSON.parse(result.text));
    } catch (err) {
      throw new SttUnavailableError('Gemini returned invalid JSON', err);
    }
    if (!parsed.success)
      throw new SttUnavailableError('Gemini returned an unexpected transcript');
    return {
      text: parsed.data.text.trim(),
      words: [],
      durationS: 0,
      provider: this.provider,
      model: this.model,
      latencyMs: result.usage.latencyMs,
      costUsd: result.usage.costUsd,
    };
  }
}
