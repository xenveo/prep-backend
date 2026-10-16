// Dev seed from the UIs' mock data (plan M0: "seed loads 3 roles"). Idempotent: rows are upserted on
// slug, email and position, so it can be re-run. Run with `npx prisma db seed`.
// Sessions and attempts are not seeded.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  type CardCategory,
  type Prisma,
} from '../src/generated/prisma/client.js';
import { workspaceSettingsSchema } from '../src/modules/settings/settings.schema.js';
import {
  ADMIN_ROLES,
  ADMIN_RUBRICS,
  ADMIN_USERS,
  ADMIN_WORKSPACE_SETTINGS,
  DEFAULT_ROLE_SETTINGS,
  type FixtureRubric,
} from './seed-data/admin-ui.js';
import {
  UI_CARDS,
  UI_QUESTIONS,
  UI_ROLES,
  type UiCard,
} from './seed-data/candidate-ui.js';
import {
  ensurePromptVersions,
  ensureWorkspaceSettings,
  syncSystemSavedFilters,
} from './system-seed.js';

const TIP_MAX = 90;

/**
 * Candidate UI card labels → CardCategory. The UI also uses Technical, Communication and Closing,
 * which the four-value enum (spec "Data model") doesn't have.
 */
const CATEGORY: Record<string, CardCategory> = {
  Behavioural: 'behavioural',
  Situational: 'situational',
  'Role knowledge': 'role_knowledge',
  Motivation: 'motivation',
  Technical: 'role_knowledge',
  Communication: 'role_knowledge',
  Closing: 'motivation',
};

/** Hand-shortened tips for the two candidate UI tips over the 90-character limit. */
const SHORT_TIPS: Record<string, string> = {
  'Say the feeling out loud: "I can see why that was frustrating." It lowers the temperature fast.':
    'Name the feeling: "I can see why that was frustrating." It lowers the temperature fast.',
  'Real examples beat general claims. Use one from your own experience, even if it was informal.':
    'Real examples beat general claims. Use one from your own life, even an informal one.',
};

const DEMO_CANDIDATES = [
  { email: 'demo.candidate@example.com', name: 'Demo Candidate' },
  { email: 'demo.candidate2@example.com', name: 'Demo Candidate Two' },
];

function category(label: string): CardCategory {
  const value = CATEGORY[label];
  if (!value) throw new Error(`Unknown card category label "${label}"`);
  return value;
}

function tip(text: string): string {
  const short = SHORT_TIPS[text] ?? text;
  return short.length <= TIP_MAX
    ? short
    : `${short.slice(0, TIP_MAX - 1).trimEnd()}…`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function descriptionHtml(text: string, bullets: string[] = []): string {
  const list = bullets.length
    ? `<ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';
  return `<p>${escapeHtml(text)}</p>${list}`;
}

function rubricFromCard(card: UiCard, cat: CardCategory): FixtureRubric {
  return {
    keyPoints: card.strong.map((point) => ({ point, example: '' })),
    redFlags: card.mistakes,
    expectedStructure:
      cat === 'behavioural' || cat === 'situational' ? 'star' : 'free',
  };
}

function withIds(rubric: FixtureRubric) {
  return {
    ...rubric,
    keyPoints: rubric.keyPoints.map((kp, i) => ({ id: `kp${i + 1}`, ...kp })),
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
    candidates: 0,
    assignments: 0,
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

    // Roles, cards, questions
    const roleIds: string[] = [];
    for (const r of UI_ROLES) {
      const fx = ADMIN_ROLES[r.slug];
      const roleData = {
        title: r.title,
        blurb: r.blurb,
        descriptionHtml: fx?.description
          ? descriptionHtml(fx.description.text, fx.description.bullets)
          : descriptionHtml(r.blurb),
        seniority: fx?.seniority ?? 'entry',
        keySkills: fx?.keySkills ?? [],
        status: 'approved' as const,
        approvedBy: ownerId,
        updatedBy: ownerId,
      };
      const role = await prisma.jobRole.upsert({
        where: { slug: r.slug },
        create: {
          slug: r.slug,
          ...roleData,
          settings: DEFAULT_ROLE_SETTINGS,
          approvedAt: now,
        },
        update: roleData,
      });
      roleIds.push(role.id);
      counts.roles++;

      const cards = UI_CARDS[r.slug] ?? [];
      const cardIds = new Map<
        number,
        { id: string; card: UiCard; category: CardCategory }
      >();
      for (const [i, card] of cards.entries()) {
        const position = i + 1;
        const cat = category(card.category);
        const cardData = {
          category: cat,
          question: card.question,
          strongAnswerPoints: card.strong,
          commonMistakes: card.mistakes,
          tip: tip(card.tip),
          status: 'approved' as const,
          approvedBy: ownerId,
        };
        const row = await prisma.flashCard.upsert({
          where: { jobRoleId_position: { jobRoleId: role.id, position } },
          create: {
            jobRoleId: role.id,
            position,
            ...cardData,
            createdBy: ownerId,
            approvedAt: now,
          },
          update: cardData,
        });
        cardIds.set(position, { id: row.id, card, category: cat });
        counts.cards++;
      }

      for (const q of UI_QUESTIONS[r.slug] ?? []) {
        const linked = cardIds.get(q.cardPosition);
        if (!linked)
          throw new Error(
            `Question "${q.text}" links to missing card ${q.cardPosition}`,
          );
        const fixture = ADMIN_RUBRICS.find(
          (f) => f.roleSlug === r.slug && q.text.startsWith(f.textPrefix),
        );
        const rubric = withIds(
          fixture?.rubric ?? rubricFromCard(linked.card, linked.category),
        );
        const questionData = {
          flashCardId: linked.id,
          category: linked.category,
          difficulty: 'medium' as const,
          rubric: rubric as Prisma.InputJsonValue,
          status: 'approved' as const,
        };
        const existing = await prisma.question.findFirst({
          where: { jobRoleId: role.id, text: q.text },
        });
        if (existing) {
          await prisma.question.update({
            where: { id: existing.id },
            data: questionData,
          });
        } else {
          await prisma.question.create({
            data: {
              jobRoleId: role.id,
              text: q.text,
              ...questionData,
              createdBy: ownerId,
            },
          });
        }
        counts.questions++;
      }
    }

    // Demo candidates, assigned to every role
    for (const c of DEMO_CANDIDATES) {
      const user = await prisma.user.upsert({
        where: { email: c.email },
        create: {
          email: c.email,
          name: c.name,
          role: 'candidate',
          status: 'active',
        },
        update: { status: 'active', deletedAt: null },
      });
      counts.candidates++;
      for (const jobRoleId of roleIds) {
        await prisma.roleAssignment.upsert({
          where: { userId_jobRoleId: { userId: user.id, jobRoleId } },
          create: { userId: user.id, jobRoleId, assignedBy: ownerId },
          update: { removedAt: null },
        });
        counts.assignments++;
      }
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
