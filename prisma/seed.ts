// Dev seed: the admin users, the ServiceNow job roles with their default flash cards and interview
// questions, and the system rows. Idempotent: users are upserted on email, roles created once by
// slug, and content added only to a role with no flash cards yet (an admin may have edited or
// approved them since), so it can be re-run. Run with `npx prisma db seed`.
// Roles stay draft for an admin to review and approve. Candidates, sessions and attempts are not
// seeded.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import {
  flashCardInputSchema,
  rubricInputSchema,
} from '../src/modules/content/content.schemas.js';
import { workspaceSettingsSchema } from '../src/modules/settings/settings.schema.js';
import {
  ADMIN_USERS,
  ADMIN_WORKSPACE_SETTINGS,
  DEFAULT_ROLE_SETTINGS,
} from './seed-data/admin-ui.js';
import {
  BEHAVIOURAL_CARDS,
  FUNDAMENTALS_CARDS,
  ROLE_CARDS,
  type SeedCard,
} from './seed-data/flash-cards.js';
import { SEED_ROLES } from './seed-data/roles.js';
import {
  ensurePromptVersions,
  ensureWorkspaceSettings,
  syncSystemSavedFilters,
} from './system-seed.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function descriptionHtml(text: string, bullets: string[] = []): string {
  const list = bullets.length
    ? `<ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';
  return `<p>${escapeHtml(text)}</p>${list}`;
}

/** Seeded roles ask their questions in random order: each card is a question, so fixed order would repeat the first few every session. */
const SEED_ROLE_SETTINGS = {
  ...DEFAULT_ROLE_SETTINGS,
  questionOrder: 'random',
};

/** The role's own cards first, then the decks every role shares. */
function cardsFor(slug: string): SeedCard[] {
  const own = ROLE_CARDS[slug];
  if (!own) throw new Error(`No flash cards for role "${slug}"`);
  return [...own, ...FUNDAMENTALS_CARDS, ...BEHAVIOURAL_CARDS];
}

/** Card and rubric for one seed card, checked against the admin API's own limits. */
function content(card: SeedCard) {
  const cardData = flashCardInputSchema.parse({
    category: card.category,
    question: card.question,
    strongAnswerPoints: card.keywords,
    sampleAnswerOutline: card.answer,
    tip: card.tip,
    commonMistakes: card.mistakes,
  });
  const rubric = rubricInputSchema.parse({
    keyPoints: card.keywords.map((point) => ({ point })),
    redFlags: card.redFlags,
    expectedStructure: card.structure,
  });
  return {
    cardData,
    rubric: {
      ...rubric,
      keyPoints: rubric.keyPoints.map((kp, i) => ({ id: `kp${i + 1}`, ...kp })),
    },
  };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  const now = new Date();
  const counts = {
    roles: 0,
    cards: 0,
    questions: 0,
    admins: 0,
    filters: 0,
    prompts: 0,
  };

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
    const adminIds: string[] = [];
    for (const a of admins) {
      const user = await prisma.user.upsert({
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
      adminIds.push(user.id);
      counts.admins++;
    }
    const ownerId = adminIds[0];

    // Roles: drafts until an admin reviews and approves them
    for (const r of SEED_ROLES) {
      const role = await prisma.jobRole.upsert({
        where: { slug: r.slug },
        create: {
          slug: r.slug,
          title: r.title,
          blurb: r.blurb,
          descriptionHtml: descriptionHtml(
            r.description.text,
            r.description.bullets,
          ),
          seniority: r.seniority,
          keySkills: r.keySkills,
          status: 'draft',
          settings: SEED_ROLE_SETTINGS,
          updatedBy: ownerId,
        },
        update: {},
      });
      counts.roles++;

      // Approved cards, each with an approved interview question linked to it
      const existingCards = await prisma.flashCard.count({
        where: { jobRoleId: role.id },
      });
      if (existingCards > 0) continue;
      await prisma.$transaction(async (tx) => {
        for (const [i, card] of cardsFor(r.slug).entries()) {
          const { cardData, rubric } = content(card);
          const row = await tx.flashCard.create({
            data: {
              jobRoleId: role.id,
              position: i + 1,
              ...cardData,
              status: 'approved',
              createdBy: ownerId,
              approvedBy: ownerId,
              approvedAt: now,
            },
          });
          await tx.question.create({
            data: {
              jobRoleId: role.id,
              flashCardId: row.id,
              text: card.interviewQuestion,
              category: card.category,
              difficulty: card.difficulty,
              rubric: rubric as Prisma.InputJsonValue,
              status: 'approved',
              createdBy: ownerId,
            },
          });
          counts.cards++;
          counts.questions++;
        }
        // A role still untouched by an admin (no cards) also takes the seeded settings.
        await tx.jobRole.update({
          where: { id: role.id },
          data: { settings: SEED_ROLE_SETTINGS },
        });
      });
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
