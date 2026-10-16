import type { TtsAdapter, TtsResult } from './tts.adapter.js';
import { estimateSpeechSeconds } from './tts-duration.js';

/** One silent MPEG-1 Layer III frame (128 kbps, 44.1 kHz): a tiny but valid mp3. */
function silentMp3Frame(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return frame;
}

export class FakeTtsAdapter implements TtsAdapter {
  readonly provider = 'fake';
  readonly mimeType = 'audio/mpeg';
  readonly model = null;

  speak(text: string, _voice?: string): Promise<TtsResult> {
    return Promise.resolve({
      audio: silentMp3Frame(),
      mimeType: this.mimeType,
      durationS: estimateSpeechSeconds(text),
      provider: this.provider,
      latencyMs: 0,
      costUsd: null,
    });
  }
}
