import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../adapters/storage/storage.adapter.js';
import { estimateSpeechSeconds } from '../../adapters/tts/tts-duration.js';
import {
  TTS_ADAPTER,
  type TtsAdapter,
} from '../../adapters/tts/tts.adapter.js';
import { sha256Hex } from '../../common/crypto.js';
import { AiCallLogService } from '../ai/ai-call-log.service.js';
import { SettingsService } from '../settings/settings.service.js';

export type TtsOptions = {
  voice?: string;
  sessionId?: string;
  attemptId?: string;
};

/** Storage key of the cached speech for (voice, text): `tts/<sha256(voice + "\n" + text)>.mp3`. */
export const ttsKey = (voice: string, text: string) =>
  `tts/${sha256Hex(`${voice}\n${text}`)}.mp3`;

/**
 * Text-to-speech cached by content hash (plan §6 "TTS", NFR-01, NFR-10). A cache hit makes no
 * provider call. Provider failures are logged and rethrown; callers decide whether to fall back.
 */
@Injectable()
export class TtsCacheService {
  constructor(
    @Inject(TTS_ADAPTER) private readonly tts: TtsAdapter,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly settings: SettingsService,
    private readonly callLog: AiCallLogService,
  ) {}

  async getOrCreate(
    text: string,
    opts: TtsOptions = {},
  ): Promise<{ key: string; durationS: number }> {
    const voice = opts.voice ?? (await this.settings.get()).voice;
    const key = ttsKey(voice, text);
    if (await this.storage.exists(key)) {
      return { key, durationS: estimateSpeechSeconds(text) };
    }
    const started = Date.now();
    try {
      const result = await this.tts.speak(text, voice);
      await this.storage.put(key, result.audio, result.mimeType);
      await this.callLog.log({
        sessionId: opts.sessionId,
        attemptId: opts.attemptId,
        kind: 'tts',
        provider: result.provider,
        audioSeconds: result.durationS,
        latencyMs: result.latencyMs || Date.now() - started,
        costUsd: result.costUsd,
        status: 'ok',
      });
      return { key, durationS: result.durationS };
    } catch (err) {
      await this.callLog.log({
        sessionId: opts.sessionId,
        attemptId: opts.attemptId,
        kind: 'tts',
        provider: this.tts.provider,
        latencyMs: Date.now() - started,
        status: 'error',
        error: err instanceof Error ? err.name : 'Error',
      });
      throw err;
    }
  }

  signedUrl(key: string): Promise<string> {
    return this.storage.signedUrl(key);
  }
}
