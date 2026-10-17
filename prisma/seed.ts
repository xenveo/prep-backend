// Dev seed: the demo admin users and the system rows. Idempotent: users are upserted on email, so it
// can be re-run. Run with `npx prisma db seed`, after the migrations: the job roles and their default
// flash cards and questions come from migration 20261017080000_servicenow_roles.
// Candidates, sessions and attempts are not seeded.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { workspaceSettingsSchema } from '../src/modules/settings/settings.schema.js';
import { ADMIN_USERS, ADMIN_WORKSPACE_SETTINGS } from './seed-data/admin-ui.js';
import {
  ensurePromptVersions,
  ensureWorkspaceSettings,
  syncSystemSavedFilters,
} from './system-seed.js';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  const counts = { admins: 0, filters: 0, prompts: 0 };

  try {
    // Admins
    const admins = [...ADMIN_USERS];
    const seedAdmin = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    if (seedAdmin && !admins.some((a) => a.email === seedAdmin)) {
      admins.push({
        email: seedAdmin,
        name: '',
        title: null,
        role: 'super_admin',
      });
    }
    for (const a of admins) {
      await prisma.user.upsert({
        where: { email: a.email },
        create: {
          email: a.email,
          name: a.name || null,
          title: a.title,
          role: a.role,
          status: 'active',
        },
        update: { role: a.role, status: 'active', deletedAt: null },
      });
      counts.admins++;
    }
    // System saved filters, then workspace settings (created once, never overwritten: admins may
    // have changed them), then version 1 of each prompt role that has none.
    const filters = await syncSystemSavedFilters(prisma);
    counts.filters = filters.created + filters.updated;
    await ensureWorkspaceSettings(
      prisma,
      workspaceSettingsSchema.parse(ADMIN_WORKSPACE_SETTINGS),
    );
    counts.prompts = (await ensurePromptVersions(prisma)).created;

    console.log(`Seed complete: ${JSON.stringify(counts)}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
