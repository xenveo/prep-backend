import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import type { JobRole, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DrafterService,
  type DraftRoleContext,
} from '../ai/drafter.service.js';
import {
  toAdminCard,
  toAdminQuestion,
  type AdminFlashCard,
  type AdminQuestion,
} from './content.serializers.js';
import { descriptionText } from './role-description.js';
import { RolesService } from './roles.service.js';

export type AiDraftJob = {
  kind: 'cards' | 'questions';
  roleId: string;
  count: number;
  adminId: string;
  ip: string | null;
};

export type AiDraftResult = AdminFlashCard[] | AdminQuestion[];

/** HTTP waits this long for a draft before answering 202 (plan §7). */
export const DRAFT_WAIT_MS = 15_000;

/** Runs AI drafting jobs (`ai-draft` queue, FR-ROLE-06): inserts `ai_draft` rows for admin review. */
@Injectable()
export class AiDraftProcessor implements OnModuleInit {
  constructor(
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    private readonly prisma: PrismaService,
    private readonly drafter: DrafterService,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.queue.process<AiDraftJob, AiDraftResult>('ai-draft', (job) =>
      this.handle(job),
    );
  }

  handle(job: AiDraftJob): Promise<AiDraftResult> {
    return job.kind === 'cards'
      ? this.draftCards(job)
      : this.draftQuestions(job);
  }

  async draftCards(job: AiDraftJob): Promise<AdminFlashCard[]> {
    const role = await this.roles.getEditableRow(job.roleId);
    const drafts = await this.drafter.draftCards(
      await this.context(role, job.count),
    );
    const created = await this.prisma.$transaction(async (tx) => {
      const last = await tx.flashCard.aggregate({
        where: { jobRoleId: role.id },
        _max: { position: true },
      });
      const base = last._max.position ?? 0;
      const rows = [];
      for (const [i, d] of drafts.entries()) {
        rows.push(
          await tx.flashCard.create({
            data: {
              jobRoleId: role.id,
              position: base + i + 1,
              category: d.category,
              question: d.question,
              strongAnswerPoints: d.strongAnswerPoints,
              commonMistakes: d.commonMistakes,
              tip: d.tip,
              sampleAnswerOutline: d.sampleAnswerOutline,
              status: 'ai_draft',
              createdBy: null,
            },
          }),
        );
      }
      await this.finish(tx, role, job, 'Drafted flash cards with AI');
      return rows;
    });
    return created.map(toAdminCard);
  }

  async draftQuestions(job: AiDraftJob): Promise<AdminQuestion[]> {
    const role = await this.roles.getEditableRow(job.roleId);
    const cards = await this.prisma.flashCard.findMany({
      where: { jobRoleId: role.id, status: { not: 'archived' } },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, question: true, category: true },
    });
    const drafts = await this.drafter.draftQuestions({
      ...(await this.context(role, job.count)),
      cards: cards.map((c) => ({
        position: c.position,
        question: c.question,
        category: c.category,
      })),
    });
    const cardIdAt = new Map(cards.map((c) => [c.position, c.id]));
    const created = await this.prisma.$transaction(async (tx) => {
      const rows = [];
      for (const d of drafts) {
        rows.push(
          await tx.question.create({
            data: {
              jobRoleId: role.id,
              flashCardId:
                d.cardPosition === null
                  ? null
                  : (cardIdAt.get(d.cardPosition) ?? null),
              text: d.text,
              category: d.category,
              difficulty: d.difficulty,
              rubric: d.rubric as unknown as Prisma.InputJsonObject,
              status: 'ai_draft',
              createdBy: null,
            },
          }),
        );
      }
      await this.finish(tx, role, job, 'Drafted questions with AI');
      return rows;
    });
    return created.map((q) => toAdminQuestion(q));
  }

  private async context(
    role: JobRole,
    count: number,
  ): Promise<DraftRoleContext> {
    const [cards, questions] = await Promise.all([
      this.prisma.flashCard.findMany({
        where: { jobRoleId: role.id },
        select: { question: true },
      }),
      this.prisma.question.findMany({
        where: { jobRoleId: role.id, status: { not: 'archived' } },
        select: { text: true },
      }),
    ]);
    return {
      roleTitle: role.title,
      descriptionText: descriptionText(role.descriptionHtml),
      keySkills: role.keySkills,
      seniority: role.seniority,
      existingQuestions: [
        ...cards.map((c) => c.question),
        ...questions.map((q) => q.text),
      ],
      count,
    };
  }

  private async finish(
    tx: Prisma.TransactionClient,
    role: JobRole,
    job: AiDraftJob,
    action: string,
  ): Promise<void> {
    await tx.jobRole.update({
      where: { id: role.id },
      data: { lastAiDraftAt: new Date(), updatedBy: job.adminId },
    });
    await this.audit.record(
      {
        actorId: job.adminId,
        action,
        entity: 'job_role',
        entityId: role.id,
        itemLabel: role.title,
        ip: job.ip,
      },
      tx,
    );
  }
}
