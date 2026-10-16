import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { AppConfig } from '../../config/app-config.js';

/** Each distinct error code is logged at most once per window, across every connection. */
export const ERROR_LOG_INTERVAL_MS = 30_000;
/** Shutdown budget for a graceful close (QUIT, BullMQ close) before the connection is dropped. */
export const CLOSE_TIMEOUT_MS = 3000;

/**
 * The shared client serves request-path commands (rate limits, publishes, health pings). During an
 * outage they fail at once instead of queueing through ioredis' ~20 reconnect retries, so a login
 * gets a prompt 500 rather than hanging. Startup waits for 'ready' first, so nothing is lost at boot.
 */
export const SHARED_CLIENT_OPTIONS = {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
} satisfies Partial<RedisOptions>;

/**
 * Runs `close`; if it hasn't succeeded within `ms`, calls `force` without waiting for it. With
 * Redis down a QUIT or BullMQ close never settles, and shutdown must still finish (SIGTERM → exit).
 */
export async function closeWithin(
  close: () => Promise<unknown>,
  force: () => unknown,
  ms = CLOSE_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });
  const closed = Promise.resolve()
    .then(close)
    .then(
      () => true,
      () => false,
    );
  const ok = await Promise.race([closed, deadline]);
  clearTimeout(timer);
  if (!ok)
    void Promise.resolve()
      .then(force)
      .catch(() => undefined);
}

/** Resolves true on the client's next 'ready', false after `ms`. */
function whenReady(client: Redis, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      resolve(false);
    }, ms);
    client.once('ready', onReady);
  });
}

/** An error's code (`ECONNREFUSED`) or, without one, its name, plus its message. Never a URL. */
function describe(err: unknown): { code: string; message: string } {
  if (!(err instanceof Error)) return { code: typeof err, message: '' };
  const { code } = err as { code?: unknown };
  return {
    code: typeof code === 'string' && code ? code : err.name,
    message: err.message,
  };
}

/**
 * Shared Redis connection (plan §8). `client` is null when REDIS_URL is unset: callers then use their
 * in-process fallback. Connections close on application shutdown, after the queue and event bus
 * have closed theirs in onModuleDestroy.
 *
 * Startup waits up to REDIS_CONNECT_TIMEOUT_MS for Redis and fails otherwise, so the orchestrator
 * restarts the process. After that an outage is survivable: ioredis keeps reconnecting, errors are
 * logged rate-limited, and /api/ready reports it.
 *
 * The server may be shared with other apps, and pub/sub ignores the DB index, so every key, channel
 * and BullMQ queue goes under `prefix`. Build names with `key()`, never by hand.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  readonly client: Redis | null;
  private readonly logger = new Logger('Redis');
  private readonly duplicates: Redis[] = [];
  private readonly keyPrefix: string;
  private readonly connectTimeoutMs: number;
  private readonly workerDrainMs: number;
  private readonly loggedAt = new Map<string, number>();
  private lastErrorCode: string | undefined;

  constructor(config: AppConfig) {
    const env = config.env;
    this.client = env.REDIS_URL
      ? this.watch(new Redis(env.REDIS_URL, SHARED_CLIENT_OPTIONS))
      : null;
    this.keyPrefix = env.REDIS_PREFIX;
    this.connectTimeoutMs = env.REDIS_CONNECT_TIMEOUT_MS;
    this.workerDrainMs = env.WORKER_DRAIN_MS;
  }

  /** Global module, so this runs before any processor opens a BullMQ connection. */
  async onModuleInit(): Promise<void> {
    const client = this.client;
    if (!client || client.status === 'ready') return;
    if (await whenReady(client, this.connectTimeoutMs)) return;
    for (const c of [...this.duplicates, client]) c.disconnect();
    const cause = this.lastErrorCode ? ` (${this.lastErrorCode})` : '';
    throw new Error(
      `Redis not reachable within ${this.connectTimeoutMs} ms${cause}`,
    );
  }

  /** Namespace for this app (`REDIS_PREFIX`), also BullMQ's queue prefix. */
  get prefix(): string {
    return this.keyPrefix;
  }

  /** A namespaced key or channel name: `key('rl', 'otp')` is `<prefix>:rl:otp`. */
  key(...parts: string[]): string {
    return [this.keyPrefix, ...parts].join(':');
  }

  /**
   * A new connection to the same server, for subscribers and BullMQ (which needs blocking connections
   * and `maxRetriesPerRequest: null`). Unlike the shared client it queues commands until connected:
   * a subscriber subscribes right after creation, and BullMQ expects the offline queue.
   */
  duplicate(override?: Partial<RedisOptions>): Redis {
    if (!this.client) throw new Error('REDIS_URL is not set');
    const connection = this.watch(
      this.client.duplicate({ enableOfflineQueue: true, ...override }) as Redis,
    );
    this.duplicates.push(connection);
    return connection;
  }

  /**
   * How long queue consumers may take to close at shutdown: WORKER_DRAIN_MS while Redis is up, so
   * in-flight jobs can finish; CLOSE_TIMEOUT_MS when it is down, since nothing can complete then.
   */
  closeBudgetMs(): number {
    return this.client?.status === 'ready'
      ? this.workerDrainMs
      : CLOSE_TIMEOUT_MS;
  }

  /**
   * Logs a Redis-related error (`source`: connection, a BullMQ queue or worker) at most once per
   * error code every ERROR_LOG_INTERVAL_MS. Code and message only, never the URL.
   */
  logError(source: string, err: unknown): void {
    const { code, message } = describe(err);
    this.lastErrorCode = code;
    const now = Date.now();
    const last = this.loggedAt.get(code);
    if (last !== undefined && now - last < ERROR_LOG_INTERVAL_MS) return;
    this.loggedAt.set(code, now);
    this.logger.warn(
      `Redis ${source} error ${code}${message ? `: ${message}` : ''} (repeats muted for ${ERROR_LOG_INTERVAL_MS / 1000} s)`,
    );
  }

  /** QUIT where the connection is up (bounded), otherwise drop it: a QUIT would wait for a reconnect. */
  async onApplicationShutdown(): Promise<void> {
    const all = this.client ? [...this.duplicates, this.client] : [];
    await Promise.all(
      all.map((c) =>
        c.status === 'ready'
          ? closeWithin(
              () => c.quit(),
              () => c.disconnect(),
            )
          : c.disconnect(),
      ),
    );
  }

  /** Without an 'error' listener ioredis prints every failed reconnect to stderr. */
  private watch(connection: Redis): Redis {
    connection.on('error', (err) => this.logError('connection', err));
    return connection;
  }
}
