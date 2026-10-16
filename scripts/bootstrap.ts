// Production bootstrap: the rows a fresh database needs before anyone can log in (docs/DEPLOYMENT.md
// "First deploy"). Run after `prisma migrate deploy`:
//
//   BOOTSTRAP_ADMIN_EMAIL=you@example.com node --env-file=<file> --import tsx scripts/bootstrap.ts
//
// Creates the workspace settings, version 1 of each prompt role, the system saved filters and the
// first super admin (active; logs in through the normal OTP flow). No roles, candidates or demo
// users: that is the dev seed (prisma/seed.ts). Idempotent: a second run changes nothing.
// Prints ids only, never the admin's email or name. Exit code: 0 done, 1 failed.
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import {
  ensurePromptVersions,
  ensureWorkspaceSettings,
  PRODUCTION_WORKSPACE_SETTINGS,
  syncSystemSavedFilters,
  type SyncCounts,
} from '../prisma/system-seed.js';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'is required'),
  BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('must be an email address')),
  BOOTSTRAP_ADMIN_NAME: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
});

type AdminResult = {
  userId: string;
  outcome: 'created' | 'upgraded' | 'unchanged';
};

/** Creates the first super admin, or makes an existing user an active super admin. */
async function ensureSuperAdmin(
  prisma: PrismaClient,
  email: string,
  name: string | undefined,
): Promise<AdminResult> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const user = await prisma.user.create({
      data: {
        email,
        name: name ?? null,
        role: 'super_admin',
        status: 'active',
      },
    });
    return { userId: user.id, outcome: 'created' };
  }
  // Erasure stage 1: the person asked to be forgotten, so don't bring the row back.
  if (existing.deletedAt)
    throw new Error(
      `User ${existing.id} is pending erasure. Use another address, or wait for the purge.`,
    );
  const data: Prisma.UserUpdateInput = {};
  if (existing.role !== 'super_admin') data.role = 'super_admin';
  if (existing.status !== 'active') data.status = 'active';
  if (existing.accessExpiresAt) data.accessExpiresAt = null;
  if (name && !existing.name) data.name = name;
  if (Object.keys(data).length === 0)
    return { userId: existing.id, outcome: 'unchanged' };
  await prisma.user.update({ where: { id: existing.id }, data });
  return { userId: existing.id, outcome: 'upgraded' };
}

function describe(counts: SyncCounts): string {
  return counts.created || counts.updated
    ? `${counts.created} created, ${counts.updated} updated`
    : 'unchanged';
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.')} ${i.message}`,
    );
    throw new Error(`Invalid environment: ${issues.join('; ')}`);
  }
  const env = parsed.data;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const settings = await ensureWorkspaceSettings(
      prisma,
      PRODUCTION_WORKSPACE_SETTINGS,
    );
    const prompts = await ensurePromptVersions(prisma);
    const filters = await syncSystemSavedFilters(prisma);
    const admin = await ensureSuperAdmin(
      prisma,
      env.BOOTSTRAP_ADMIN_EMAIL,
      env.BOOTSTRAP_ADMIN_NAME,
    );
    console.log(`Workspace settings: ${describe(settings)}`);
    console.log(`Prompt versions: ${describe(prompts)}`);
    console.log(`System saved filters: ${describe(filters)}`);
    console.log(`Super admin ${admin.userId}: ${admin.outcome}`);
    const changed =
      [settings, prompts, filters].some((c) => c.created || c.updated) ||
      admin.outcome !== 'unchanged';
    console.log(
      changed ? 'Bootstrap complete.' : 'Bootstrap complete: nothing to do.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await main();
} catch (err) {
  console.error(
    `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
}
