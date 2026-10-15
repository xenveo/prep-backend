import type { IncomingMessage, Server } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { SESSION_COOKIE } from '../../../common/auth/auth.types.js';
import { sha256Hex } from '../../../common/crypto.js';
import {
  EVENT_BUS,
  sessionChannel,
  USER_REVOKED_CHANNEL,
  type EventBus,
  type Unsubscribe,
  type UserRevokedEvent,
} from '../../../common/events/event-bus.types.js';
import { AppConfig } from '../../../config/app-config.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

const PATH_RE = /^\/(?:api\/)?ws\/sessions\/([^/]+)\/?$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PING_INTERVAL_MS = 30_000;
/** Close code sent when the user's access is revoked while connected. */
export const CLOSE_REVOKED = 4401;
const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/** The session id when the path is ours (`/ws/sessions/:id`, also under `/api`), else null. */
export function matchSessionPath(url: string | undefined): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  return PATH_RE.exec(pathname)?.[1] ?? null;
}

export function parseCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

const originOf = (u: string): string | null => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

export type UpgradeAuth =
  | { ok: true; userId: string; sessionId: string }
  | { ok: false; status: 401 | 403 | 404 };

/**
 * Authorizes a WS upgrade: Origin allow-list (cross-site WebSocket hijacking), the `pp_session`
 * cookie checked like SessionGuard, and ownership of the interview session.
 */
export async function authorizeUpgrade(
  req: Pick<IncomingMessage, 'url' | 'headers'>,
  deps: {
    prisma: Pick<PrismaService, 'authSession' | 'session'>;
    allowedOrigins: string[];
    now?: Date;
  },
): Promise<UpgradeAuth> {
  const sessionId = matchSessionPath(req.url);
  if (!sessionId) return { ok: false, status: 404 };

  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set(
      deps.allowedOrigins.map(originOf).filter((o): o is string => !!o),
    );
    const o = originOf(origin);
    if (!o || !allowed.has(o)) return { ok: false, status: 403 };
  }

  const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token) return { ok: false, status: 401 };
  const auth = await deps.prisma.authSession.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: true },
  });
  const now = deps.now ?? new Date();
  if (!auth || auth.revokedAt || auth.expiresAt <= now)
    return { ok: false, status: 401 };
  const { user } = auth;
  if (user.deletedAt || user.status !== 'active')
    return { ok: false, status: 401 };
  if (user.accessExpiresAt && user.accessExpiresAt <= now)
    return { ok: false, status: 403 };

  if (!UUID_RE.test(sessionId)) return { ok: false, status: 404 };
  const session = await deps.prisma.session.findFirst({
    where: { id: sessionId, userId: user.id },
    select: { id: true },
  });
  if (!session) return { ok: false, status: 404 };
  return { ok: true, userId: user.id, sessionId };
}

type Client = {
  ws: WebSocket;
  userId: string;
  sessionId: string;
  alive: boolean;
};
type Channel = {
  clients: Set<Client>;
  unsubscribe: Promise<Unsubscribe | null>;
};

/**
 * `WS /ws/sessions/:id` (plan §6 "WebSocket gateway"). Relays `session:{id}` events to the
 * candidate's sockets as JSON `{type, ...payload}`. Raw `ws` server on the Nest HTTP server's
 * `upgrade` event, since the path is dynamic; other upgrade paths are left alone.
 */
@Injectable()
export class SessionGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SessionGateway.name);
  private readonly channels = new Map<string, Channel>();
  private readonly byUser = new Map<string, Set<Client>>();
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private revokedUnsub: Unsubscribe | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      Server | undefined;
    if (!server) return; // worker process: no HTTP server
    this.httpServer = server;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CLIENT_FRAME_BYTES,
    });
    server.on('upgrade', this.onUpgrade);
    this.revokedUnsub = await this.events.subscribe(
      USER_REVOKED_CHANNEL,
      (e: UserRevokedEvent) => this.closeUser(e.userId),
    );
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.httpServer?.off('upgrade', this.onUpgrade);
    for (const set of this.byUser.values())
      for (const c of set) c.ws.close(1001, 'Server shutting down');
    const unsubs = [...this.channels.values()].map((c) => c.unsubscribe);
    this.channels.clear();
    this.byUser.clear();
    await Promise.all(
      unsubs.map((p) => p.then((u) => u?.()).catch(() => undefined)),
    );
    await this.revokedUnsub?.().catch(() => undefined);
    this.wss?.close();
  }

  /** Open sockets per session (tests and diagnostics). */
  socketCount(sessionId: string): number {
    return this.channels.get(sessionId)?.clients.size ?? 0;
  }

  private readonly onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (!matchSessionPath(req.url)) return;
    socket.on('error', () => socket.destroy());
    const { env } = this.config;
    authorizeUpgrade(req, {
      prisma: this.prisma,
      allowedOrigins: [
        env.APP_CANDIDATE_ORIGIN,
        env.APP_ADMIN_ORIGIN,
        env.PUBLIC_API_URL,
      ],
    })
      .then((auth) => {
        if (!auth.ok) return reject(socket, auth.status);
        if (!this.wss) return reject(socket, 503);
        this.wss.handleUpgrade(req, socket, head, (ws) =>
          this.attach(ws, auth.userId, auth.sessionId),
        );
      })
      .catch((err) => {
        this.logger.error(
          `ws upgrade failed (${err instanceof Error ? err.name : typeof err})`,
        );
        reject(socket, 500);
      });
  };

  private attach(ws: WebSocket, userId: string, sessionId: string): void {
    const client: Client = { ws, userId, sessionId, alive: true };
    let users = this.byUser.get(userId);
    if (!users) this.byUser.set(userId, (users = new Set()));
    users.add(client);

    let channel = this.channels.get(sessionId);
    if (!channel) {
      const clients = new Set<Client>();
      channel = {
        clients,
        unsubscribe: this.events
          .subscribe(sessionChannel(sessionId), (event: object) =>
            this.relay(clients, event),
          )
          .catch((err) => {
            this.logger.error(
              `subscribe failed for session ${sessionId} (${err instanceof Error ? err.name : typeof err})`,
            );
            return null;
          }),
      };
      this.channels.set(sessionId, channel);
    }
    channel.clients.add(client);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data: RawData, isBinary: boolean) =>
      this.onMessage(client, data, isBinary),
    );
    ws.on('error', () => ws.terminate());
    ws.on('close', () => this.detach(client));
  }

  private detach(client: Client): void {
    const users = this.byUser.get(client.userId);
    users?.delete(client);
    if (users?.size === 0) this.byUser.delete(client.userId);

    const channel = this.channels.get(client.sessionId);
    if (!channel) return;
    channel.clients.delete(client);
    if (channel.clients.size > 0) return;
    this.channels.delete(client.sessionId);
    void channel.unsubscribe.then((u) => u?.()).catch(() => undefined);
  }

  private relay(clients: Set<Client>, event: object): void {
    const frame = JSON.stringify(event);
    for (const c of clients)
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(frame);
  }

  /** Only `{"type":"ping"}` is answered; live `audio.chunk` STT is a future item (FR-INT-05). */
  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    let msg: unknown;
    try {
      msg = JSON.parse(rawToString(data));
    } catch {
      return;
    }
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: unknown }).type === 'ping' &&
      client.ws.readyState === WebSocket.OPEN
    )
      client.ws.send(JSON.stringify({ type: 'pong' }));
  }

  private closeUser(userId: string): void {
    const users = this.byUser.get(userId);
    if (!users) return;
    for (const c of users) c.ws.close(CLOSE_REVOKED, 'Access revoked');
  }

  private heartbeat(): void {
    for (const set of this.byUser.values()) {
      for (const c of set) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function reject(socket: Duplex, status: number): void {
  if (!socket.writable) return void socket.destroy();
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
