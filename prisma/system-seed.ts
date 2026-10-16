// System rows every database needs, shared by the dev seed (prisma/seed.ts) and the production
// bootstrap (scripts/bootstrap.ts). Each function is idempotent and writes only what is missing or
// out of date, so re-running it is a no-op.
import { isDeepStrictEqual } from 'node:util';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { DEFAULT_PROMPTS } from '../src/modules/ai/prompts/defaults.js';
import {
  workspaceSettingsSchema,
  type WorkspaceSettingsData,
} from '../src/modules/settings/settings.schema.js';
import {
  ADMIN_WORKSPACE_SETTINGS,
  SYSTEM_SAVED_FILTERS,
} from './seed-data/admin-ui.js';

export type SyncCounts = { created: number; updated: number };

/** The dev seed's settings without the admin fixture's placeholders. Admins set a reply-to later. */
export const PRODUCTION_WORKSPACE_SETTINGS: WorkspaceSettingsData =
  workspaceSettingsSchema.parse({
    ...ADMIN_WORKSPACE_SETTINGS,
    senderName: 'PrepPilot',
    replyTo: '',
  });

/** Creates the settings row once and never overwrites it (admins may have changed it). */
export async function ensureWorkspaceSettings(
  prisma: PrismaClient,
  data: WorkspaceSettingsData,
): Promise<SyncCounts> {
  const existing = await prisma.workspaceSettings.findUnique({
    where: { id: 1 },
  });
  if (existing) return { created: 0, updated: 0 };
  await prisma.workspaceSettings.create({
    data: { id: 1, data: data as Prisma.InputJsonValue },
  });
  return { created: 1, updated: 0 };
}

/** Version 1, active, of each default prompt, for any prompt role that has no rows at all. */
export async function ensurePromptVersions(
  prisma: PrismaClient,
): Promise<SyncCounts> {
  let created = 0;
  for (const p of DEFAULT_PROMPTS) {
    const any = await prisma.promptVersion.findFirst({
      where: { role: p.role },
    });
    if (any) continue;
    await prisma.promptVersion.create({
      data: {
        role: p.role,
        version: 1,
        model: p.model,
        temperature: p.temperature,
        thinkingLevel: p.thinkingLevel,
        template: p.template,
        active: true,
      },
    });
    created++;
  }
  return { created, updated: 0 };
}

/** System saved filters (adminId null, read-only to admins), matched on label and kept in line with the code. */
export async function syncSystemSavedFilters(
  prisma: PrismaClient,
): Promise<SyncCounts> {
  const counts = { created: 0, updated: 0 };
  for (const f of SYSTEM_SAVED_FILTERS) {
    const existing = await prisma.savedFilter.findFirst({
      where: { adminId: null, label: f.label },
    });
    const data = {
      query: f.query as Prisma.InputJsonValue,
      isDefault: f.isDefault,
    };
    if (!existing) {
      await prisma.savedFilter.create({
        data: { label: f.label, adminId: null, ...data },
      });
      counts.created++;
    } else if (
      existing.isDefault !== f.isDefault ||
      !isDeepStrictEqual(existing.query, f.query)
    ) {
      await prisma.savedFilter.update({ where: { id: existing.id }, data });
      counts.updated++;
    }
  }
  return counts;
}
