import type { GeminiClient } from '../gemini/gemini.client.js';
import { GeminiError } from '../gemini/gemini.errors.js';
import {
  type TtsAdapter,
  type TtsResult,
  TtsUnavailableError,
} from './tts.adapter.js';

/** WorkspaceSettings.voice labels (admin UI) → Gemini prebuilt voices confirmed on our key in P0. */
export const GEMINI_VOICES: Record<string, string> = {
  'Calm, mid-pitch': 'en-in-podcaster-7',
  'Warm, lower pitch': 'charon',
  'Bright, higher pitch': 'en-in-tutor-11',
};
const DEFAULT_VOICE = 'Calm, mid-pitch';

/**
 * Seconds of audio in a PCM WAV file (data bytes ÷ byte rate), or null when `buf` isn't one.
 * A data size past the end of the buffer (streamed WAVs write a placeholder) is clamped to it.
 */
export function wavDurationS(buf: Buffer): number | null {
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && body + 12 <= buf.length)
      byteRate = buf.readUInt32LE(body + 8);
    if (id === 'data') {
      if (!byteRate) return null;
      return Math.min(size, buf.length - body) / byteRate;
    }
    at = body + size + (size % 2);
  }
  return null;
}

/**
 * gemini-3.8-flash-tts, the interviewer's voice (plan 01-gemini "TTS adapter"). The text is the
 * only part and is read verbatim. The API returns WAV (24 kHz mono 16-bit in P0), stored as is.
 */
export class GeminiTtsAdapter implements TtsAdapter {
  readonly provider = 'gemini';
  readonly mimeType = 'audio/wav';

  constructor(
    private readonly gemini: GeminiClient,
    private readonly model: string,
  ) {}

  async speak(text: string, voice: string): Promise<TtsResult> {
    const voiceName = GEMINI_VOICES[voice] ?? GEMINI_VOICES[DEFAULT_VOICE];
    let result;
    try {
      result = await this.gemini.generate({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text }] }],
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      });
    } catch (err) {
      const code = err instanceof GeminiError ? err.code : 'unknown';
      throw new TtsUnavailableError(`Gemini voicing failed: ${code}`, err);
    }

    const data = result.response.candidates?.[0]?.content?.parts?.find(
      (p) => p.inlineData?.data,
    )?.inlineData?.data;
    if (!data) throw new TtsUnavailableError('Gemini returned no audio');
    const audio = Buffer.from(data, 'base64');
    const durationS = wavDurationS(audio);
    if (durationS === null)
      throw new TtsUnavailableError('Gemini returned audio that is not WAV');
    return {
      audio,
      mimeType: this.mimeType,
      durationS: Math.round(durationS * 10) / 10,
      provider: this.provider,
      latencyMs: result.usage.latencyMs,
      costUsd: result.usage.costUsd,
    };
  }
}
