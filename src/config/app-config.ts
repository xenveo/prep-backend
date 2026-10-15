import { envSchema, type Env } from './env.js';

/** Parsed, validated environment. Inject this and read `config.env.X`; never read process.env directly. */
export class AppConfig {
  constructor(readonly env: Env) {}
}

/** Parses the environment, failing fast with the offending variable names (never their values). */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment configuration:\n  ${problems.join('\n  ')}`,
    );
  }
  return new AppConfig(parsed.data);
}
