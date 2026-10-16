import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  conflict,
  forbidden,
  notFound,
} from '../../common/errors/app-error.js';
import {
  keysetPage,
  keysetWhere,
  type Page,
  type PaginationQuery,
} from '../../common/pagination/pagination.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { ErasureHideJob } from './erasure.service.js';
import { ExportService } from './export.service.js';
import { requireUuid } from './ids.js';

export type PrivacyKind = 'export' | 'deletion';

/** No admin UI screen exists for privacy requests, so these action strings are the backend's own. */
export const PRIVACY_AUDIT_ACTION: Record<PrivacyKind, string> = {
  deletion: 'Completed deletion request',
  export: 'Completed export request',
};

/** Completed requests stay in the admin list this long. */
const RECENT_DAYS = 30;
/** Completed requests stay in the candidate's own list this long. */
const OWN_RECENT_DAYS = 90;

export type PrivacyRequestView = {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  kind: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  completedBy: string | null;
};

/** GET /me/privacy-requests row. Anything that left pending (completed, or a rejected row) is closed: 'completed'. */
export type OwnPrivacyRequestView = {
  id: string;
  kind: PrivacyKind;
  status: 'pending' | 'completed';
  createdAt: string;
  completedAt: string | null;
};

/** Candidate export and deletion requests (NFR-06, DPDP Act 2023). */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly exports: ExportService,
    private readonly audit: AuditService,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  /** GET /me/export: queues the JSON bundle at once. Idempotent while one is pending. */
  async requestExport(userId: string): Promise<{ requestId: string }> {
    const pending = await this.pendingRequest(userId, 'export');
    if (pending) return { requestId: pending.id };
    const request = await this.prisma.privacyRequest.create({
      data: { userId, kind: 'export', status: 'pending' },
    });
    await this.exports.startCandidateExport(userId, userId, request.id);
    return { requestId: request.id };
  }

  /** POST /me/deletion-request: queued for a super admin to action. Idempotent while one is pending. */
  async requestDeletion(userId: string): Promise<{ requestId: string }> {
    const { candidatesCanDeleteData } = await this.settings.get();
    if (!candidatesCanDeleteData)
      throw forbidden(
        'Deletion requests are turned off. Contact your admin team.',
      );
    const pending = await this.pendingRequest(userId, 'deletion');
    if (pending) return { requestId: pending.id };
    const request = await this.prisma.privacyRequest.create({
      data: { userId, kind: 'deletion', status: 'pending' },
    });
    return { requestId: request.id };
  }

  /** GET /me/privacy-requests: the caller's pending requests and those from the last 90 days, newest first. */
  async listOwn(
    userId: string,
    now = new Date(),
  ): Promise<OwnPrivacyRequestView[]> {
    const rows = await this.prisma.privacyRequest.findMany({
      where: {
        userId,
        OR: [
          { status: 'pending' },
          {
            createdAt: {
              gte: new Date(now.getTime() - OWN_RECENT_DAYS * 864e5),
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as PrivacyKind,
      status: r.status === 'pending' ? 'pending' : 'completed',
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    }));
  }

  /** Pending requests and those from the last 30 days, newest first. Hidden users drop out. */
  async list(
    query: PaginationQuery,
    now = new Date(),
  ): Promise<Page<PrivacyRequestView>> {
    const where = {
      OR: [
        { status: 'pending' },
        { createdAt: { gte: new Date(now.getTime() - RECENT_DAYS * 864e5) } },
      ],
    };
    const after = keysetWhere('createdAt', query.cursor);
    const [fetched, total] = await Promise.all([
      this.prisma.privacyRequest.findMany({
        where: after ? { AND: [where, after] } : where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: { user: { select: { name: true, email: true } } },
      }),
      this.prisma.privacyRequest.count({ where }),
    ]);
    const { rows, nextCursor } = keysetPage(fetched, query.limit, (r) => ({
      at: r.createdAt,
      id: r.id,
    }));
    return { rows: rows.map((r) => toView(r, r.user)), nextCursor, total };
  }

  /**
   * POST /admin/privacy/requests/:id/complete. Deletion starts erasure stage 1; export queues the
   * candidate's bundle (emailed to them) unless one is already in flight (409). Both are audited.
   * Only one caller can move a request out of pending; the other gets a 409.
   */
  async complete(
    id: string,
    actorId: string,
    ip: string | null,
  ): Promise<PrivacyRequestView> {
    const request = await this.prisma.privacyRequest.findUnique({
      where: { id: requireUuid(id, 'Request not found') },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!request) throw notFound('Request not found');
    if (request.status !== 'pending')
      throw conflict('This request has already been handled');
    const kind = request.kind as PrivacyKind;
    if (kind === 'export' && (await this.exportInFlight(request.userId)))
      throw conflict('An export for this candidate is already in progress');

    const completion = {
      status: 'completed',
      completedAt: new Date(),
      completedBy: actorId,
    };
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.privacyRequest.updateMany({
        where: { id: request.id, status: 'pending' },
        data: completion,
      });
      if (count === 0) throw conflict('This request has already been handled');
      await this.audit.record(
        {
          actorId,
          action: PRIVACY_AUDIT_ACTION[kind],
          entity: 'user',
          entityId: request.userId,
          itemLabel: request.user.name?.trim() || request.user.email,
          ip,
        },
        tx,
      );
    });

    if (kind === 'deletion') {
      await this.queue.add<ErasureHideJob>(
        'erasure-hide',
        {
          userId: request.userId,
          requestedBy: actorId,
          requestedAt: request.createdAt.toISOString(),
        },
        { jobId: `erasure-hide-${request.userId}`, attempts: 3 },
      );
    } else {
      await this.exports.startCandidateExport(request.userId, actorId);
    }
    return toView({ ...request, ...completion }, request.user);
  }

  private async exportInFlight(subjectId: string): Promise<boolean> {
    const job = await this.prisma.exportJob.findFirst({
      where: {
        subjectId,
        kind: 'candidate_json',
        status: { in: ['queued', 'running'] },
      },
      select: { id: true },
    });
    return job !== null;
  }

  private pendingRequest(userId: string, kind: PrivacyKind) {
    return this.prisma.privacyRequest.findFirst({
      where: { userId, kind, status: 'pending' },
      select: { id: true },
    });
  }
}

function toView(
  r: {
    id: string;
    userId: string;
    kind: string;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
    completedBy: string | null;
  },
  user: { name: string | null; email: string },
): PrivacyRequestView {
  return {
    id: r.id,
    userId: r.userId,
    name: user.name,
    email: user.email,
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    completedBy: r.completedBy,
  };
}
