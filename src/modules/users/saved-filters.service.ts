import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
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
}

function toView(row: SavedFilterRow): SavedFilter {
  // A stored query that no longer parses shows as "all candidates" rather than failing the list.
  const query = candidateQuerySchema.safeParse(row.query);
  return {
    id: row.id,
    label: row.label,
    query: query.success ? query.data : {},
    ...(row.isDefault ? { isDefault: true } : {}),
  };
}
