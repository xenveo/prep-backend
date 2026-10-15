import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  conflict,
  notFound,
  validationFailed,
} from '../../common/errors/app-error.js';
import { toAdminBand } from '../../common/mapping/enums.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { AppConfig } from '../../config/app-config.js';
import type {
  JobRole,
  Prisma,
  RoleStatus,
} from '../../generated/prisma/client.js';
import { EmailService } from '../../jobs/email/email.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { bandFor } from '../interview/scoring/score.js';
import {
  DEFAULT_ROLE_SETTINGS,
  type RoleSettings,
  type Rubric,
} from '../interview/types.js';
import type { RoleInput, RolePatch } from './content.schemas.js';
import {
  toAdminRole,
  type AdminJobRole,
  type RoleDerived,
} from './content.serializers.js';
import { avgLatestScores } from './question-stats.sql.js';
import { sanitizeDescription } from './role-description.js';
import { enqueueTtsPregen } from './tts-pregen.processor.js';

type Db = PrismaService | Prisma.TransactionClient;

/** Who did it, for `updatedBy` and the audit log. */
export type Actor = { id: string; ip: string | null };

export type ApproveRequirements = {
  canApprove: boolean;
  firstUnmet: string | null;
  requirements: { id: string; label: string; met: boolean }[];
  approvedFlashCards: number;
  approvedQuestions: number;
  candidatesToNotify: number;
};

const MIN_RUBRIC_QUESTIONS = 5;
const ENTITY = 'job_role';
/** Assignment users who get the role-assigned email and count as "to notify". */
const NOTIFY_STATUSES = ['active', 'invite_pending'] as const;

const sum = (o: Record<string, number>) =>
  Object.values(o).reduce((a, b) => a + b, 0);

/** Every weight group sums to 100, with the admin UI's messages. Throws 400. */
export function assertWeights(settings: RoleSettings): void {
  if (sum(settings.sessionWeights) !== 100)
    throw validationFailed('Session score weights must add up to 100%');
  if (sum(settings.dimensionWeights) !== 100)
    throw validationFailed('Answer dimension weights must add up to 100%');
}

/** "Customer Support Associate" → "customer-support-associate". */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'role'
  );
}

/** First of `base`, `base-2`, `base-3`… not in `taken`. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Job roles for admins: CRUD, approve and archive (FR-ROLE-01..05, spec "Roles and content"). */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly config: AppConfig,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  async list(status?: RoleStatus): Promise<AdminJobRole[]> {
    const roles = await this.prisma.jobRole.findMany({
      where: status ? { status } : {},
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    const derived = await this.derive(roles);
    return roles.map((r) => toAdminRole(r, derived.get(r.id)!));
  }

  async get(id: string): Promise<AdminJobRole> {
    const role = await this.getRow(id);
    const derived = await this.derive([role]);
    return toAdminRole(role, derived.get(role.id)!);
  }

  /** The role row or 404. */
  async getRow(id: string, db: Db = this.prisma): Promise<JobRole> {
    const role = await db.jobRole.findUnique({ where: { id } });
    if (!role) throw notFound('Role not found');
    return role;
  }

  /** The role row; 404 if missing, 409 if archived (archived roles are read-only). */
  async getEditableRow(id: string, db: Db = this.prisma): Promise<JobRole> {
    const role = await this.getRow(id, db);
    if (role.status === 'archived')
      throw conflict("Archived roles can't be edited");
    return role;
  }

  /** Stamps `updatedBy`/`updatedAt` after a content change. */
  async touch(id: string, adminId: string, db: Db = this.prisma) {
    await db.jobRole.update({ where: { id }, data: { updatedBy: adminId } });
  }

  async create(input: RoleInput, actor: Actor): Promise<AdminJobRole> {
    const base = slugify(input.title);
    const taken = await this.prisma.jobRole.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.jobRole.create({
        data: {
          slug: uniqueSlug(
            base,
            taken.map((t) => t.slug),
          ),
          title: input.title,
          seniority: input.seniority,
          descriptionHtml: sanitizeDescription(input.description ?? ''),
          keySkills: input.keySkills ?? [],
          settings: DEFAULT_ROLE_SETTINGS as unknown as Prisma.InputJsonObject,
          updatedBy: actor.id,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'Created role',
          entity: ENTITY,
          entityId: created.id,
          itemLabel: created.title,
          ip: actor.ip,
        },
        tx,
      );
      return created;
    });
    return this.get(role.id);
  }

  async update(
    id: string,
    patch: RolePatch,
    actor: Actor,
  ): Promise<AdminJobRole> {
    const role = await this.getEditableRow(id);
    if (patch.settings) assertWeights(patch.settings);
    const data: Prisma.JobRoleUpdateInput = { updatedBy: actor.id };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      data.title = patch.title;
      before.title = role.title;
      after.title = patch.title;
    }
    if (patch.seniority !== undefined) {
      data.seniority = patch.seniority;
      before.seniority = role.seniority;
      after.seniority = patch.seniority;
    }
    if (patch.description !== undefined) {
      data.descriptionHtml = sanitizeDescription(patch.description);
      before.description = role.descriptionHtml;
      after.description = data.descriptionHtml;
    }
    if (patch.keySkills !== undefined) {
      data.keySkills = patch.keySkills;
      before.keySkills = role.keySkills;
      after.keySkills = patch.keySkills;
    }
    if (patch.settings !== undefined) {
      data.settings = patch.settings as unknown as Prisma.InputJsonObject;
      before.settings = role.settings;
      after.settings = patch.settings;
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.jobRole.update({ where: { id }, data });
      // The UI autosaves every 800 ms: one row per admin per role per 10 minutes.
      await this.audit.recordMerged(
        {
          actorId: actor.id,
          action: 'Edited role',
          entity: ENTITY,
          entityId: id,
          itemLabel: updated.title,
          before,
          after,
          ip: actor.ip,
        },
        10,
        tx,
      );
    });
    return this.get(id);
  }

  async requirements(id: string): Promise<ApproveRequirements> {
    const role = await this.getRow(id);
    return this.computeRequirements(role, this.prisma);
  }

  /** Draft → approved, then queues question TTS and emails assigned candidates (plan §7 "Approve role"). */
  async approve(
    id: string,
    actor: Actor,
  ): Promise<{ role: AdminJobRole; notified: number }> {
    const role = await this.prisma.$transaction(async (tx) => {
      const current = await this.getRow(id, tx);
      if (current.status !== 'draft')
        throw conflict('Only a draft role can be approved');
      const req = await this.computeRequirements(current, tx);
      if (!req.canApprove)
        throw conflict(req.firstUnmet ?? 'Requirements not met');
      const approved = await tx.jobRole.update({
        where: { id },
        data: {
          status: 'approved',
          approvedAt: new Date(),
          approvedBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'Approved role',
          entity: ENTITY,
          entityId: id,
          itemLabel: approved.title,
          ip: actor.ip,
        },
        tx,
      );
      return approved;
    });

    const questions = await this.prisma.question.findMany({
      where: { jobRoleId: id, status: 'approved' },
      select: { id: true },
    });
    for (const q of questions) await enqueueTtsPregen(this.queue, q.id);

    const recipients = await this.prisma.roleAssignment.findMany({
      where: {
        jobRoleId: id,
        removedAt: null,
        user: { status: { in: [...NOTIFY_STATUSES] } },
      },
      select: { user: { select: { email: true, name: true } } },
    });
    const link = `${this.config.env.APP_CANDIDATE_ORIGIN}/roles/${role.slug}`;
    for (const { user } of recipients) {
      await this.email.send({
        template: 'role-assigned',
        to: user.email,
        vars: { name: user.name ?? '', roleTitle: role.title, link },
      });
    }
    return { role: await this.get(id), notified: recipients.length };
  }

  /** Approved or draft → archived. Hidden from candidates; scores are kept. */
  async archive(id: string, actor: Actor): Promise<AdminJobRole> {
    await this.prisma.$transaction(async (tx) => {
      const role = await this.getRow(id, tx);
      if (role.status === 'archived')
        throw conflict('Role is already archived');
      await tx.jobRole.update({
        where: { id },
        data: { status: 'archived', updatedBy: actor.id },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'Archived role',
          entity: ENTITY,
          entityId: id,
          itemLabel: role.title,
          ip: actor.ip,
        },
        tx,
      );
    });
    return this.get(id);
  }

  private async computeRequirements(
    role: JobRole,
    db: Db,
  ): Promise<ApproveRequirements> {
    const settings = role.settings as RoleSettings;
    const minQuestions = Math.max(
      MIN_RUBRIC_QUESTIONS,
      settings.questionsPerSession,
    );
    const [questions, approvedFlashCards, candidatesToNotify] =
      await Promise.all([
        db.question.findMany({
          where: { jobRoleId: role.id, status: 'approved' },
          select: { rubric: true, card: { select: { status: true } } },
        }),
        db.flashCard.count({
          where: { jobRoleId: role.id, status: 'approved' },
        }),
        db.roleAssignment.count({
          where: {
            jobRoleId: role.id,
            removedAt: null,
            user: { status: { in: [...NOTIFY_STATUSES] } },
          },
        }),
      ]);
    // The linked card must be approved, or "Review on card N" points at a card candidates can't see.
    const ready = questions.filter(
      (q) =>
        q.card?.status === 'approved' &&
        ((q.rubric as Rubric | null)?.keyPoints?.length ?? 0) >= 1,
    ).length;
    const requirements = [
      {
        id: 'questions',
        label: `Add at least ${minQuestions} questions with rubrics and a linked flash card`,
        met: ready >= minQuestions,
      },
      {
        id: 'cards',
        label: 'Approve at least 1 flash card',
        met: approvedFlashCards >= 1,
      },
      {
        id: 'session-weights',
        label: 'Make the session score weights add up to 100%',
        met: sum(settings.sessionWeights) === 100,
      },
      {
        id: 'dimension-weights',
        label: 'Make the answer dimension weights add up to 100%',
        met: sum(settings.dimensionWeights) === 100,
      },
    ];
    const firstUnmet = requirements.find((r) => !r.met)?.label ?? null;
    return {
      canApprove: firstUnmet === null,
      firstUnmet,
      requirements,
      approvedFlashCards,
      approvedQuestions: questions.length,
      candidatesToNotify,
    };
  }

  /** Counts, assigned candidates, average latest score (approved roles only) and editor names. */
  private async derive(roles: JobRole[]): Promise<Map<string, RoleDerived>> {
    const ids = roles.map((r) => r.id);
    const editorIds = [
      ...new Set(roles.map((r) => r.updatedBy).filter((x) => x !== null)),
    ];
    const [cards, questions, assigned, editors, averages] = await Promise.all([
      this.prisma.flashCard.groupBy({
        by: ['jobRoleId', 'status'],
        where: { jobRoleId: { in: ids }, status: { not: 'archived' } },
        _count: { _all: true },
      }),
      this.prisma.question.groupBy({
        by: ['jobRoleId', 'status'],
        where: { jobRoleId: { in: ids }, status: { not: 'archived' } },
        _count: { _all: true },
      }),
      this.prisma.roleAssignment.groupBy({
        by: ['jobRoleId'],
        where: { jobRoleId: { in: ids }, removedAt: null },
        _count: { _all: true },
      }),
      editorIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: editorIds } },
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([]),
      avgLatestScores(
        this.prisma,
        roles.filter((r) => r.status === 'approved').map((r) => r.id),
      ),
    ]);
    const editorName = new Map(editors.map((e) => [e.id, e.name ?? e.email]));
    const out = new Map<string, RoleDerived>();
    for (const role of roles) {
      const c = cards.filter((g) => g.jobRoleId === role.id);
      const q = questions.filter((g) => g.jobRoleId === role.id);
      const avg = averages.get(role.id) ?? null;
      out.set(role.id, {
        updatedByName: role.updatedBy
          ? (editorName.get(role.updatedBy) ?? null)
          : null,
        flashCardCount: c.reduce((n, g) => n + g._count._all, 0),
        questionCount: q.reduce((n, g) => n + g._count._all, 0),
        aiDraftCardCount:
          c.find((g) => g.status === 'ai_draft')?._count._all ?? 0,
        aiDraftQuestionCount:
          q.find((g) => g.status === 'ai_draft')?._count._all ?? 0,
        candidatesAssigned:
          assigned.find((g) => g.jobRoleId === role.id)?._count._all ?? 0,
        avgLatestScore: avg,
        avgLatestBand: avg === null ? null : toAdminBand(bandFor(avg)),
      });
    }
    return out;
  }
}
