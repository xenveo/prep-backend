import { Injectable, Logger } from '@nestjs/common';
import { validationFailed } from '../../common/errors/app-error.js';
import { formatZodIssues } from '../../common/validation/zod.pipe.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  workspaceSettingsSchema,
  type AdminWorkspaceSettings,
  type WorkspaceSettingsData,
} from './settings.schema.js';

const ROW_ID = 1;
const CACHE_MS = 30_000;

/** The single-row workspace settings document (spec "Workspace settings", plan §13). */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { data: WorkspaceSettingsData; until: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Stored settings over the defaults. Cached in memory for ~30 s per process. */
  async get(): Promise<WorkspaceSettingsData> {
    if (this.cache && this.cache.until > Date.now()) return this.cache.data;
    const data = await this.load();
    this.cache = { data, until: Date.now() + CACHE_MS };
    return data;
  }

  /** Validates the merged document and saves it. Throws 400 validation_failed. */
  async update(
    patch: Partial<WorkspaceSettingsData>,
  ): Promise<{ before: WorkspaceSettingsData; after: WorkspaceSettingsData }> {
    const before = await this.load();
    const parsed = workspaceSettingsSchema.safeParse({
      ...before,
      ...patch,
      language: 'en',
    });
    if (!parsed.success)
      throw validationFailed(formatZodIssues(parsed.error.issues));
    const after = parsed.data;
    const data = after as unknown as Prisma.InputJsonObject;
    await this.prisma.workspaceSettings.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, data },
      update: { data },
    });
    this.cache = null;
    return { before, after };
  }

  /** The admin UI's WorkspaceSettings shape: backend-only fields removed. */
  toAdminView(data: WorkspaceSettingsData): AdminWorkspaceSettings {
    const {
      erasureGraceDays: _grace,
      deliveryTargets: _targets,
      ...view
    } = data;
    return view;
  }

  private async load(): Promise<WorkspaceSettingsData> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { id: ROW_ID },
    });
    const stored = isObject(row?.data) ? row.data : {};
    const parsed = workspaceSettingsSchema.safeParse(stored);
    if (parsed.success) return parsed.data;

    // A bad stored field falls back to its default rather than breaking every request.
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    this.logger.warn(
      `Invalid workspace settings fields, using defaults: ${[...bad].join(', ')}`,
    );
    const kept = Object.fromEntries(
      Object.entries(stored).filter(([k]) => !bad.has(k)),
    );
    return workspaceSettingsSchema.parse(kept);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
