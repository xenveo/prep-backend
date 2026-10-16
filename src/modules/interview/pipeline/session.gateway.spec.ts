import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { WebSocket } from 'ws';
import { sha256Hex } from '../../../common/crypto.js';
import {
  sessionChannel,
  USER_REVOKED_CHANNEL,
} from '../../../common/events/event-bus.types.js';
import { InMemoryEventBus } from '../../../common/events/in-memory-event-bus.js';
import type { AppConfig } from '../../../config/app-config.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  authorizeUpgrade,
  CLOSE_REVOKED,
  matchSessionPath,
  parseCookie,
  SessionGateway,
} from './session.gateway.js';

const SESSION_ID = '0b8f7c1e-6f5d-4f4e-9a54-3c2b1a0d9e8f';
const OTHER_SESSION = '1c9a8d2f-7e6d-4a5b-8c4d-2b1a0f9e8d7c';
const TOKEN = 'tok-123';
const ORIGIN = 'http://localhost:3001';
const DAY = 864e5;

function prismaStub(over: { auth?: object | null; user?: object } = {}) {
  const now = Date.now();
  const user = {
    id: 'u1',
    status: 'active',
    deletedAt: null,
    accessExpiresAt: null,
    ...over.user,
  };
  const auth =
    over.auth === null
      ? null
      : {
          revokedAt: null,
          expiresAt: new Date(now + DAY),
          user,
          ...over.auth,
        };
  return {
    authSession: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.tokenHash === sha256Hex(TOKEN) ? auth : null,
      ),
    },
    session: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === SESSION_ID && where.userId === 'u1'
          ? { id: SESSION_ID }
          : null,
      ),
    },
  };
}

const req = (
  url: string,
  headers: Record<string, string | undefined> = {
    cookie: `pp_session=${TOKEN}`,
    origin: ORIGIN,
  },
) => ({ url, headers });

const auth = (
  r: ReturnType<typeof req>,
  prisma: ReturnType<typeof prismaStub> = prismaStub(),
) =>
  authorizeUpgrade(r as any, {
    prisma: prisma as unknown as PrismaService,
    allowedOrigins: [ORIGIN, 'http://localhost:3002', 'http://localhost:3000'],
    adminOrigin: 'http://localhost:3002',
  });

describe('matchSessionPath / parseCookie', () => {
  it('matches /ws/sessions/:id and /api/ws/sessions/:id only', () => {
    expect(matchSessionPath(`/ws/sessions/${SESSION_ID}`)).toBe(SESSION_ID);
    expect(matchSessionPath(`/api/ws/sessions/${SESSION_ID}/?x=1`)).toBe(
      SESSION_ID,
    );
    expect(matchSessionPath('/ws/other')).toBeNull();
    expect(matchSessionPath(`/ws/sessions/${SESSION_ID}/extra`)).toBeNull();
    expect(matchSessionPath(undefined)).toBeNull();
  });

  it('reads one cookie', () => {
    expect(parseCookie('a=1; pp_session=abc%3D; b=2', 'pp_session')).toBe(
      'abc=',
    );
    expect(parseCookie('a=1', 'pp_session')).toBeNull();
    expect(parseCookie(undefined, 'pp_session')).toBeNull();
  });
});

describe('authorizeUpgrade', () => {
  it('accepts the owner with a live session', async () => {
    await expect(auth(req(`/ws/sessions/${SESSION_ID}`))).resolves.toEqual({
      ok: true,
      userId: 'u1',
      sessionId: SESSION_ID,
    });
  });

  it('accepts a request without an Origin header (non-browser client)', async () => {
    const r = req(`/ws/sessions/${SESSION_ID}`, {
      cookie: `pp_session=${TOKEN}`,
    });
    await expect(auth(r)).resolves.toMatchObject({ ok: true });
  });

  it("reads the admin app's own cookie for upgrades from the admin origin", async () => {
    const both = { cookie: `pp_session=other; pp_admin_session=${TOKEN}` };
    await expect(
      auth(
        req(`/ws/sessions/${SESSION_ID}`, {
          ...both,
          origin: 'http://localhost:3002',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      auth(req(`/ws/sessions/${SESSION_ID}`, { ...both, origin: ORIGIN })),
    ).resolves.toEqual({ ok: false, status: 401 });
  });

  it('rejects a foreign Origin with 403', async () => {
    const r = req(`/ws/sessions/${SESSION_ID}`, {
      cookie: `pp_session=${TOKEN}`,
      origin: 'https://evil.example',
    });
    await expect(auth(r)).resolves.toEqual({ ok: false, status: 403 });
  });

  it.each([
    ['no cookie', { headers: { origin: ORIGIN } }, {}],
    ['unknown token', { headers: { cookie: 'pp_session=nope' } }, {}],
    ['revoked session', {}, { auth: { revokedAt: new Date() } }],
    ['expired session', {}, { auth: { expiresAt: new Date(Date.now() - 1) } }],
    ['deactivated user', {}, { user: { status: 'deactivated' } }],
    ['erased user', {}, { user: { deletedAt: new Date() } }],
  ])('rejects %s with 401', async (_label, r: any, p) => {
    const request = req(
      `/ws/sessions/${SESSION_ID}`,
      r.headers ?? { cookie: `pp_session=${TOKEN}` },
    );
    await expect(auth(request, prismaStub(p))).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it('rejects expired access with 403', async () => {
    await expect(
      auth(
        req(`/ws/sessions/${SESSION_ID}`),
        prismaStub({ user: { accessExpiresAt: new Date(Date.now() - 1) } }),
      ),
    ).resolves.toEqual({ ok: false, status: 403 });
  });

  it('rejects a session the user does not own, or a bad id, with 404', async () => {
    await expect(auth(req(`/ws/sessions/${OTHER_SESSION}`))).resolves.toEqual({
      ok: false,
      status: 404,
    });
    await expect(auth(req('/ws/sessions/not-a-uuid'))).resolves.toEqual({
      ok: false,
      status: 404,
    });
  });
});

describe('SessionGateway', () => {
  let server: Server;
  let gateway: SessionGateway;
  let bus: InMemoryEventBus;
  let url: string;

  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() =>
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']),
  );

  beforeEach(async () => {
    server = createServer((_q, res) => res.end());
    bus = new InMemoryEventBus();
    gateway = new SessionGateway(
      {
        httpAdapter: { getHttpServer: () => server },
      } as unknown as HttpAdapterHost,
      prismaStub() as unknown as PrismaService,
      {
        env: {
          APP_CANDIDATE_ORIGIN: ORIGIN,
          APP_ADMIN_ORIGIN: 'http://localhost:3002',
          PUBLIC_API_URL: 'http://localhost:3000',
        },
      } as unknown as AppConfig,
      bus,
    );
    await gateway.onApplicationBootstrap();
    await new Promise<void>((r) => server.listen(0, r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await gateway.beforeApplicationShutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const connect = (
    path: string,
    headers: Record<string, string> = {
      Cookie: `pp_session=${TOKEN}`,
      Origin: ORIGIN,
    },
  ) => {
    const ws = new WebSocket(`${url}${path}`, { headers });
    const messages: any[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    return { ws, messages };
  };
  const opened = (ws: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it('relays session events to every socket of the session and answers ping', async () => {
    const a = connect(`/ws/sessions/${SESSION_ID}`);
    const b = connect(`/api/ws/sessions/${SESSION_ID}`);
    await Promise.all([opened(a.ws), opened(b.ws)]);
    expect(gateway.socketCount(SESSION_ID)).toBe(2);

    await bus.publish(sessionChannel(SESSION_ID), {
      type: 'feedback.audio_ready',
      attemptId: 'a1',
      url: '/api/attempts/a1/feedback-audio',
    });
    await bus.publish(sessionChannel(OTHER_SESSION), { type: 'other' });
    await until(() => a.messages.length === 1 && b.messages.length === 1);
    expect(a.messages[0]).toEqual({
      type: 'feedback.audio_ready',
      attemptId: 'a1',
      url: '/api/attempts/a1/feedback-audio',
    });

    a.ws.send('not json');
    a.ws.send(JSON.stringify({ type: 'audio.chunk' }));
    a.ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => a.messages.length === 2);
    expect(a.messages[1]).toEqual({ type: 'pong' });

    a.ws.close();
    b.ws.close();
    await until(() => gateway.socketCount(SESSION_ID) === 0);
  });

  it('rejects an unauthenticated upgrade with 401', async () => {
    const { ws } = connect(`/ws/sessions/${SESSION_ID}`, { Origin: ORIGIN });
    const status = await new Promise<number>((resolve) =>
      ws.once('unexpected-response', (_req, res) =>
        resolve(res.statusCode ?? 0),
      ),
    );
    expect(status).toBe(401);
  });

  it('rejects a session the user does not own with 404', async () => {
    const { ws } = connect(`/ws/sessions/${OTHER_SESSION}`);
    const status = await new Promise<number>((resolve) =>
      ws.once('unexpected-response', (_req, res) =>
        resolve(res.statusCode ?? 0),
      ),
    );
    expect(status).toBe(404);
  });

  it('leaves other upgrade paths alone', async () => {
    const upgrades: string[] = [];
    server.on('upgrade', (r, socket) => {
      if (r.url === '/elsewhere') {
        upgrades.push(r.url);
        socket.destroy();
      }
    });
    const { ws } = connect('/elsewhere');
    await new Promise((r) => ws.once('error', r));
    expect(upgrades).toEqual(['/elsewhere']);
  });

  it('closes the user sockets with 4401 on revocation', async () => {
    const a = connect(`/ws/sessions/${SESSION_ID}`);
    await opened(a.ws);
    const closed = new Promise<number>((r) => a.ws.once('close', r));
    await bus.publish(USER_REVOKED_CHANNEL, { userId: 'u1' });
    await expect(closed).resolves.toBe(CLOSE_REVOKED);
  });

  it('closes open sockets before the HTTP server shuts down, so server.close() can finish', async () => {
    const a = connect(`/ws/sessions/${SESSION_ID}`);
    await opened(a.ws);
    const closed = new Promise<number>((r) => a.ws.once('close', r));
    await gateway.beforeApplicationShutdown();
    await expect(closed).resolves.toBe(1001);
    // No closeAllConnections(): a lingering upgraded socket would keep this from resolving.
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    server.listen(0); // afterEach closes it again
  });
});
