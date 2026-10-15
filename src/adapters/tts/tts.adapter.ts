// Text-to-speech contract. Callers cache by content hash in storage (tts/{sha256(voice+text)}.mp3).

export const TTS_ADAPTER = Symbol('TTS_ADAPTER');

export type TtsResult = {
  audio: Buffer;
  mimeType: string;
  /** Estimated or measured length in seconds. */
  durationS: number;
  provider: string;
  latencyMs: number;
  costUsd: number | null;
};

export interface TtsAdapter {
  readonly provider: string;
  /** `voice` is the WorkspaceSettings.voice label ("Calm, mid-pitch"); the adapter maps it to a provider voice. */
  speak(text: string, voice: string): Promise<TtsResult>;
}

export class TtsUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TtsUnavailableError';
  }
}
