// Shared e2e setup: the real AppModule over Postgres with fake providers (vitest.config.e2e.ts),
// configured exactly like main.ts. Each spec uses a unique RUN prefix for its rows and removes them.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { randomToken, sha256Hex } from '../../src/common/crypto.js';
import { SESSION_COOKIE } from '../../src/common/auth/auth.types.js';
import { InMemoryQueueService } from '../../src/common/queue/in-memory-queue.service.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../src/common/queue/queue.types.js';
import type { Prisma, UserRole } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export type TestApp = {
  app: NestExpressApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
};

/** Boots the app. `override` can swap providers (e.g. EmailService) before compile. */
export async function createTestApp(
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (override) builder = override(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

/** A unique prefix for this spec's rows, e.g. `runId('content')` → "e2e-content-lx3k9". */
export const runId = (label: string) =>
  `e2e-${label}-${Date.now().toString(36)}`;

/**
 * Creates an active user and a live auth session, skipping the OTP flow.
 * Returns the user and a `Cookie` header value for supertest's `.set('Cookie', cookie)`.
 */
export async function loginAs(
  prisma: PrismaService,
  input: {
    email: string;
    role?: UserRole;
    name?: string;
  } & Partial<Prisma.UserCreateInput>,
) {
  const { email, role = 'candidate', name = 'Test User', ...rest } = input;
  const user = await prisma.user.create({
    data: {
      email,
      role,
      name,
      status: 'active',
      firstLoginAt: new Date(),
      ...rest,
    },
  });
  const token = randomToken();
  const now = new Date();
  await prisma.authSession.create({
    data: {
      userId: user.id,
      tokenHash: sha256Hex(token),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 7 * 864e5),
    },
  });
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

/** Hard-deletes users whose email starts with the prefix (cascades to their rows). */
export async function cleanupUsers(prisma: PrismaService, prefix: string) {
  await prisma.unfiltered.user.deleteMany({
    where: { email: { startsWith: prefix } },
  });
}

/** Polls `probe` until it returns a truthy value, or throws after `timeoutMs`. */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 5000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Waits for queued background work to finish, in either queue mode. The in-memory queue (no
 * REDIS_URL) drains outright; BullMQ has no drain, so `done` (a DB or job-state check for the
 * work's last write) is polled until it holds. `done` must hold in both modes.
 */
export async function settle(
  t: TestApp,
  done: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const queue = t.app.get<QueueService>(QUEUE_SERVICE);
  if (queue instanceof InMemoryQueueService) await queue.drain();
  await waitFor(done, timeoutMs);
}
