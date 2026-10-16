// Environment contract (plan §3). Secrets and infrastructure only: prompts, models, weights and
// retention live in the DB (NFR-12). Parsed once at boot by ConfigModule; inject AppConfig to read it.
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().default(3000),
  /** api = HTTP only; worker = queue processors only (src/worker.ts); all = both (dev, tests, in-memory queue). */
  PROCESS_ROLE: z.enum(['all', 'api', 'worker']).default('all'),

  DATABASE_URL: z.string().min(1),
  /** Unset = in-process queue, pub/sub and rate limits (single process only). */
  REDIS_URL: z.string().optional(),
  /** Namespace for every Redis key, BullMQ queue and pub/sub channel; pub/sub ignores the DB index, so a shared server needs it. */
  REDIS_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('preppilot'),

  STORAGE_PROVIDER: z.enum(['s3', 'local']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  /** MinIO in dev. */
  S3_ENDPOINT: z.string().optional(),
  LOCAL_STORAGE_DIR: z.string().default('.data/storage'),
  AUDIO_URL_TTL_SEC: z.coerce.number().int().default(300),
  /** Public base URL of this API, for links it signs itself (local storage, email links to the API). */
  PUBLIC_API_URL: z.string().default('http://localhost:3000'),

  APP_CANDIDATE_ORIGIN: z.string().default('http://localhost:3001'),
  APP_ADMIN_ORIGIN: z.string().default('http://localhost:3002'),
  /** Express 'trust proxy' value behind a load balancer, e.g. "1" (hop count) or "loopback, 10.0.0.0/8". Unset = off; req.ip feeds the per-IP OTP limit. */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v && /^\d+$/.test(v) ? Number(v) : v)),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().default(7),
  /** Server pepper for OTP HMACs and local signed URLs. */
  AUTH_SECRET: z.string().min(16),

  OTP_TTL_MIN: z.coerce.number().int().default(10),
  OTP_MAX_TRIES: z.coerce.number().int().default(5),
  OTP_REQUESTS_PER_HOUR: z.coerce.number().int().default(5),
  OTP_IP_REQUESTS_PER_HOUR: z.coerce.number().int().default(20),
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().default(30),
  /** Dev only: any well-formed code logs in an eligible user. Refused when NODE_ENV=production. */
  AUTH_DEV_ACCEPT_ANY_CODE: bool,
  AI_ADMIN_CALLS_PER_HOUR: z.coerce.number().int().default(30),

  LLM_PROVIDER: z.enum(['gemini', 'anthropic', 'fake']).default('fake'),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Regional endpoint (data residency, plan §1). */
  ANTHROPIC_BASE_URL: z.string().optional(),
  STT_PROVIDER: z.enum(['gemini', 'deepgram', 'fake']).default('fake'),
  DEEPGRAM_API_KEY: z.string().optional(),
  TTS_PROVIDER: z.enum(['gemini', 'elevenlabs', 'fake']).default('fake'),
  ELEVENLABS_API_KEY: z.string().optional(),
  /** Required when any provider is `gemini`. Use a paid-tier key: free-tier content may be used by Google. */
  GEMINI_API_KEY: z.string().optional(),
  /** LLM models live in prompt_versions (NFR-12); speech models are infrastructure. */
  GEMINI_STT_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_TTS_MODEL: z.string().default('gemini-3.8-flash-tts'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  MAIL_PROVIDER: z.enum(['resend', 'ses', 'console']).default('console'),
  MAIL_FROM: z.string().default('no-reply@preppilot.local'),
  RESEND_API_KEY: z.string().optional(),
  /** Comma-separated addresses or "@domain" suffixes. When set, only these recipients get real mail; the rest go to the console outbox. */
  MAIL_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Provider send rate; the email queue is limited to it. */
  MAIL_RATE_PER_SECOND: z.coerce.number().int().min(1).default(2),
  SES_REGION: z.string().default('ap-south-1'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  LOG_PRETTY: bool,
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
}).refine(
  (env) => !(env.AUTH_DEV_ACCEPT_ANY_CODE && env.NODE_ENV === 'production'),
  {
    message: 'must not be true in production',
    path: ['AUTH_DEV_ACCEPT_ANY_CODE'],
  },
);

export type Env = z.infer<typeof envSchema>;
