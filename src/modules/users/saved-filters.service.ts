import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { notFound } from '../../common/errors/app-error.js';
import type {
  Prisma,
  SavedFilter as SavedFilterRow,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  candidateQuerySchema,
  type SavedFilter,
  type SaveFilterBody,
} from './users.schemas.js';

/** Candidate-list saved filters: the seeded system rows (adminId null) plus each admin's own. */
@Injectable()
export class SavedFiltersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(adminId: string): Promise<SavedFilter[]> {
    const rows = await this.prisma.savedFilter.findMany({
      where: { OR: [{ adminId: null }, { adminId }] },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toView);
  }

  async create(
    admin: AuthUser,
    body: SaveFilterBody,
    ip: string | null,
  ): Promise<SavedFilter> {
    const row = await this.prisma.savedFilter.create({
      data: {
        adminId: admin.id,
        label: body.label.trim() || 'Saved filter',
        query: body.query as Prisma.InputJsonObject,
      },
    });
    await this.audit.record({
      actorId: admin.id,
      action: 'Saved a filter',
      entity: 'saved_filter',
      entityId: row.id,
      itemLabel: row.label,
      ip,
    });
    return toView(row);
  }

  /** Deletes one of the caller's own filters. System rows and other admins' filters are 404. */
  async remove(admin: AuthUser, id: string, ip: string | null): Promise<void> {
    const row = await this.prisma.savedFilter.findFirst({
      where: { id, adminId: admin.id },
    });
    if (!row) throw notFound('Saved filter not found');
    const { count } = await this.prisma.savedFilter.deleteMany({
      where: { id: row.id, adminId: admin.id },
    });
    if (count === 0) throw notFound('Saved filter not found');
    await this.audit.record({
      actorId: admin.id,
      action: 'Deleted a saved filter',
      entity: 'saved_filter',
      entityId: row.id,
      itemLabel: row.label,
      ip,
    });
  }
}

function toView(row: SavedFilterRow): SavedFilter {
  // A stored query that no longer parses shows as "all candidates" rather than failing the list.
  const query = candidateQuerySchema.safeParse(row.query);
  return {
    id: row.id,
    label: row.label,
    adminId: row.adminId,
    query: query.success ? query.data : {},
    ...(row.isDefault ? { isDefault: true } : {}),
  };
}
