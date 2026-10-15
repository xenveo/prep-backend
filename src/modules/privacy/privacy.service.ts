import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  conflict,
  forbidden,
  notFound,
} from '../../common/errors/app-error.js';
import {
  decodeCursor,
  paginate,
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
    const [rows, total] = await Promise.all([
      this.prisma.privacyRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: decodeCursor(query.cursor),
        take: query.limit,
        include: { user: { select: { name: true, email: true } } },
      }),
      this.prisma.privacyRequest.count({ where }),
    ]);
    return paginate(
      rows.map((r) => toView(r, r.user)),
      total,
      query.cursor,
      query.limit,
    );
  }

  /**
   * POST /admin/privacy/requests/:id/complete. Deletion starts erasure stage 1; export queues the
   * candidate's bundle (emailed to them). Both are audited.
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.privacyRequest.update({
        where: { id: request.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          completedBy: actorId,
        },
      });
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
      return row;
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
    return toView(updated, request.user);
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
