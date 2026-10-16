import { join } from 'node:path';
import { Global, Module, type Provider } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import type { Env } from '../config/env.js';
import { AnthropicLlmAdapter } from './llm/anthropic-llm.adapter.js';
import { FakeLlmAdapter } from './llm/fake-llm.adapter.js';
import { LLM_ADAPTER, type LlmAdapter } from './llm/llm.adapter.js';
import { ConsoleMailAdapter } from './mail/console-mail.adapter.js';
import { MAIL_ADAPTER, type MailAdapter } from './mail/mail.adapter.js';
import { ResendMailAdapter } from './mail/resend-mail.adapter.js';
import { SesMailAdapter } from './mail/ses-mail.adapter.js';
import { LocalStorageAdapter } from './storage/local-storage.adapter.js';
import { LocalStorageController } from './storage/local-storage.controller.js';
import { S3StorageAdapter } from './storage/s3-storage.adapter.js';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from './storage/storage.adapter.js';
import { DeepgramSttAdapter } from './stt/deepgram-stt.adapter.js';
import { FakeSttAdapter } from './stt/fake-stt.adapter.js';
import { STT_ADAPTER, type SttAdapter } from './stt/stt.adapter.js';
import { ElevenLabsTtsAdapter } from './tts/elevenlabs-tts.adapter.js';
import { FakeTtsAdapter } from './tts/fake-tts.adapter.js';
import { TTS_ADAPTER, type TtsAdapter } from './tts/tts.adapter.js';

function required(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== 'string' || !value)
    throw new Error(`${key} is required for the configured provider`);
  return value;
}

/** Resend sends allowlisted recipients only (when MAIL_ALLOWLIST is set) and routes the rest to the console outbox. */
export function createMailAdapter(env: Env): MailAdapter {
  const outbox = new ConsoleMailAdapter(
    env.NODE_ENV === 'development'
      ? join(env.LOCAL_STORAGE_DIR, 'outbox')
      : undefined,
  );
  if (env.MAIL_PROVIDER === 'resend')
    return new ResendMailAdapter(
      required(env, 'RESEND_API_KEY'),
      env.MAIL_ALLOWLIST,
      outbox,
    );
  return env.MAIL_PROVIDER === 'ses'
    ? new SesMailAdapter(env.SES_REGION)
    : outbox;
}

const providers: Provider[] = [
  {
    provide: LLM_ADAPTER,
    inject: [AppConfig],
    useFactory: ({ env }: AppConfig): LlmAdapter =>
      env.LLM_PROVIDER === 'anthropic'
        ? new AnthropicLlmAdapter({
            apiKey: required(env, 'ANTHROPIC_API_KEY'),
            baseURL: env.ANTHROPIC_BASE_URL,
          })
        : new FakeLlmAdapter(),
  },
  {
    provide: STT_ADAPTER,
    inject: [AppConfig],
    useFactory: ({ env }: AppConfig): SttAdapter =>
      env.STT_PROVIDER === 'deepgram'
        ? new DeepgramSttAdapter(required(env, 'DEEPGRAM_API_KEY'))
        : new FakeSttAdapter(),
  },
  {
    provide: TTS_ADAPTER,
    inject: [AppConfig],
    useFactory: ({ env }: AppConfig): TtsAdapter =>
      env.TTS_PROVIDER === 'elevenlabs'
        ? new ElevenLabsTtsAdapter(required(env, 'ELEVENLABS_API_KEY'))
        : new FakeTtsAdapter(),
  },
  {
    provide: MAIL_ADAPTER,
    inject: [AppConfig],
    useFactory: ({ env }: AppConfig): MailAdapter => createMailAdapter(env),
  },
  {
    provide: STORAGE_ADAPTER,
    inject: [AppConfig],
    useFactory: ({ env }: AppConfig): StorageAdapter =>
      env.STORAGE_PROVIDER === 's3'
        ? new S3StorageAdapter({
            bucket: required(env, 'S3_BUCKET'),
            region: env.S3_REGION,
            endpoint: env.S3_ENDPOINT,
            defaultTtlSec: env.AUDIO_URL_TTL_SEC,
          })
        : new LocalStorageAdapter({
            dir: env.LOCAL_STORAGE_DIR,
            publicApiUrl: env.PUBLIC_API_URL,
            secret: env.AUTH_SECRET,
            defaultTtlSec: env.AUDIO_URL_TTL_SEC,
          }),
  },
];

/**
 * Provider adapters, chosen from env. Module metadata is fixed at import time, so the local
 * storage route is registered from the raw env (dotenv loads first in main.ts); the controller
 * also returns 404 when the active adapter isn't local.
 */
@Global()
@Module({
  controllers:
    process.env.STORAGE_PROVIDER === 's3' ? [] : [LocalStorageController],
  providers,
  exports: [
    LLM_ADAPTER,
    STT_ADAPTER,
    TTS_ADAPTER,
    MAIL_ADAPTER,
    STORAGE_ADAPTER,
  ],
})
export class AdaptersModule {}
