// Speech-to-text contract (plan §6). Batch in R1, with word timestamps.

export const STT_ADAPTER = Symbol('STT_ADAPTER');

export type SttWord = { w: string; start: number; end: number };

export type SttResult = {
  text: string;
  words: SttWord[];
  /** Audio length in seconds, as measured by the provider. */
  durationS: number;
  provider: string;
  model: string | null;
  latencyMs: number;
  costUsd: number | null;
};

export interface SttAdapter {
  readonly provider: string;
  transcribe(
    audio: Buffer,
    opts: { mimeType: string; language: 'en' },
  ): Promise<SttResult>;
}

export class SttUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SttUnavailableError';
  }
}
