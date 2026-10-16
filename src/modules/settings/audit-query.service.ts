import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  keysetPage,
  keysetWhere,
  paginationQuerySchema,
  type Page,
} from '../../common/pagination/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const day = z.iso.date();

/** GET /admin/audit: the admin UI's AuditFilters plus cursor/limit. Dates are UTC days. */
export const auditQuerySchema = paginationQuerySchema.extend({
  actorId: z.uuid().optional(),
  action: z.string().trim().min(1).max(200).optional(),
  from: day.optional(),
  to: day.optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** The admin UI's AuditEvent. */
export type AuditEventView = {
  id: string;
  actorId: string | null;
  actor: string;
  action: string;
  itemLabel: string;
  itemRef?: string;
  at: string;
};

export const SYSTEM_ACTOR = 'System';

/** Reads the audit log for the admin Settings → Audit screen (FR-ADM-06). */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first, keyset-paged on (at, id). `to` includes the whole day. */
  async list(query: AuditQuery): Promise<Page<AuditEventView>> {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.from || query.to) {
      where.at = {
        ...(query.from && { gte: new Date(`${query.from}T00:00:00.000Z`) }),
        ...(query.to && { lt: nextDay(query.to) }),
      };
    }
    const after = keysetWhere('at', query.cursor);
    const [fetched, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: after ? { AND: [where, after] } : where,
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const { rows, nextCursor } = keysetPage(fetched, query.limit, (r) => r);
    const names = await this.actorNames(rows.map((r) => r.actorId));
    return {
      rows: rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actor: (r.actorId && names.get(r.actorId)) || SYSTEM_ACTOR,
        action: r.action,
        itemLabel: r.itemLabel,
        ...(r.entityId && { itemRef: r.entityId }),
        at: r.at.toISOString(),
      })),
      nextCursor,
      total,
    };
  }

  /** Distinct actions, sorted, for the "Action" filter. */
  async actions(): Promise<string[]> {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['action'],
      orderBy: { action: 'asc' },
    });
    return rows.map((r) => r.action);
  }

  /** Display name (or email when unnamed) per actor; erased users are filtered out, so they read "System". */
  private async actorNames(
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
  }
}

function nextDay(date: string): Date {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
