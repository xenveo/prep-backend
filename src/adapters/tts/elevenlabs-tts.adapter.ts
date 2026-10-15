import {
  type TtsAdapter,
  type TtsResult,
  TtsUnavailableError,
} from './tts.adapter.js';
import { estimateSpeechSeconds } from './tts-duration.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';
const MODEL_ID = 'eleven_multilingual_v2';
const TIMEOUT_MS = 20_000;

/** WorkspaceSettings.voice labels (admin UI) → ElevenLabs premade voice ids. */
export const ELEVENLABS_VOICES: Record<string, string> = {
  'Calm, mid-pitch': '21m00Tcm4TlvDq8ikWAM',
  'Warm, lower pitch': 'pNInz6obpgDQGcFmaJgB',
  'Bright, higher pitch': 'EXAVITQu4vr4xnSDxMaL',
};
const DEFAULT_VOICE = 'Calm, mid-pitch';

export class ElevenLabsTtsAdapter implements TtsAdapter {
  readonly provider = 'elevenlabs';

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async speak(text: string, voice: string): Promise<TtsResult> {
    const voiceId =
      ELEVENLABS_VOICES[voice] ?? ELEVENLABS_VOICES[DEFAULT_VOICE];
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchFn(
        `${ENDPOINT}/${voiceId}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: MODEL_ID }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch (err) {
      throw new TtsUnavailableError('ElevenLabs request failed', err);
    }
    if (!res.ok)
      throw new TtsUnavailableError(`ElevenLabs returned ${res.status}`);
    const audio = Buffer.from(await res.arrayBuffer());
    return {
      audio,
      mimeType: 'audio/mpeg',
      durationS: estimateSpeechSeconds(text),
      provider: this.provider,
      latencyMs: Date.now() - started,
      costUsd: null,
    };
  }
}
