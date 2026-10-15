import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { notFound, validationFailed } from '../../common/errors/app-error.js';
import { toAdminBand } from '../../common/mapping/enums.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import type { Prisma, Question } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiQuotaService } from './ai-quota.service.js';
import { EvaluatorService } from '../ai/evaluator.service.js';
import type { EvaluatorOutput } from '../ai/schemas.js';
import { bandFor } from '../interview/scoring/score.js';
import type { RoleSettings, Rubric } from '../interview/types.js';
import type { QuestionInput } from './content.schemas.js';
import {
  toAdminQuestion,
  type AdminQuestion,
  type TestEvaluation,
} from './content.serializers.js';
import { questionStats } from './question-stats.sql.js';
import { RolesService, type Actor } from './roles.service.js';
import { enqueueTtsPregen } from './tts-pregen.processor.js';

const ENTITY = 'question';

/** Stored rubric: key points get ids kp1, kp2… in order. */
export function toStoredRubric(input: QuestionInput['rubric']): Rubric {
  return {
    keyPoints: input.keyPoints.map((k, i) => ({
      id: `kp${i + 1}`,
      point: k.point,
      example: k.example,
    })),
    redFlags: input.redFlags,
    expectedStructure: input.expectedStructure,
  };
}

const unique = (items: string[]) => [...new Set(items.filter(Boolean))];

/** Evaluator output → the admin UI's TestEvaluation. */
export function toTestEvaluation(
  answer: string,
  score: number,
  subScores: TestEvaluation['subScores'],
  output: EvaluatorOutput,
  rubric: Rubric,
): TestEvaluation {
  const pointText = new Map(rubric.keyPoints.map((k) => [k.id, k.point]));
  const matched = output.highlights
    .filter((h) => h.kind === 'match')
    .map((h) =>
      h.rubric_point_id && pointText.has(h.rubric_point_id)
        ? pointText.get(h.rubric_point_id)!
        : h.note,
    );
  const issues = output.highlights
    .filter((h) => h.kind === 'issue')
    .map((h) => h.note);
  return {
    answer,
    score,
    band: toAdminBand(bandFor(score)),
    subScores,
    matched: unique([...matched, ...output.worked]),
    issues: unique([...issues, ...output.improve]),
    candidateFeedback: [...output.worked, ...output.improve].join(' '),
    isTest: true,
  };
}

/** Question bank for admins (FR-ROLE-04/05, spec "Roles and content"). */
@Injectable()
export class QuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
    private readonly evaluator: EvaluatorService,
    private readonly quota: AiQuotaService,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  /** Live questions (archived ones hidden), oldest first, with usage stats. */
  async list(roleId: string): Promise<AdminQuestion[]> {
    await this.roles.getRow(roleId);
    const [questions, stats] = await Promise.all([
      this.prisma.question.findMany({
        where: { jobRoleId: roleId, status: { not: 'archived' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      questionStats(this.prisma, roleId),
    ]);
    return questions.map((q) => toAdminQuestion(q, stats.get(q.id)));
  }

  async create(
    roleId: string,
    input: QuestionInput,
    actor: Actor,
  ): Promise<AdminQuestion> {
    const { question, roleApproved } = await this.prisma.$transaction(
      async (tx) => {
        const role = await this.roles.getEditableRow(roleId, tx);
        await this.assertCard(tx, roleId, input.cardId);
        const created = await tx.question.create({
          data: {
            jobRoleId: roleId,
            flashCardId: input.cardId ?? null,
            text: input.text,
            category: input.category,
            difficulty: input.difficulty,
            rubric: toStoredRubric(
              input.rubric,
            ) as unknown as Prisma.InputJsonObject,
            status: input.status ?? 'approved',
            createdBy: actor.id,
          },
        });
        await this.roles.touch(roleId, actor.id, tx);
        await this.record('Added question', created, role.title, actor, tx);
        return {
          question: created,
          roleApproved: role.status === 'approved',
        };
      },
    );
    if (roleApproved && question.status === 'approved')
      await enqueueTtsPregen(this.queue, question.id);
    return this.single(question);
  }

  /** Edits a question; `status: "approved"` approves it. A text change re-renders the audio. */
  async update(
    questionId: string,
    input: QuestionInput,
    actor: Actor,
  ): Promise<AdminQuestion> {
    const { question, pregen } = await this.prisma.$transaction(async (tx) => {
      const current = await this.getQuestion(questionId, tx);
      if (current.status === 'archived') throw notFound('Question not found');
      const role = await this.roles.getEditableRow(current.jobRoleId, tx);
      if (input.cardId !== undefined)
        await this.assertCard(tx, role.id, input.cardId);
      const status = input.status ?? current.status;
      const textChanged = input.text !== current.text;
      const approving = status === 'approved' && current.status !== 'approved';
      const updated = await tx.question.update({
        where: { id: questionId },
        data: {
          text: input.text,
          category: input.category,
          difficulty: input.difficulty,
          rubric: toStoredRubric(
            input.rubric,
          ) as unknown as Prisma.InputJsonObject,
          status,
          ...(input.cardId !== undefined ? { flashCardId: input.cardId } : {}),
          ...(textChanged ? { audioKey: null } : {}),
        },
      });
      await this.roles.touch(role.id, actor.id, tx);
      await this.record(
        approving ? 'Approved question' : 'Edited question',
        updated,
        role.title,
        actor,
        tx,
      );
      return {
        question: updated,
        pregen:
          role.status === 'approved' &&
          status === 'approved' &&
          (textChanged || approving || !current.audioKey),
      };
    });
    if (pregen) await enqueueTtsPregen(this.queue, question.id);
    return this.single(question);
  }

  /** Archives a question that has been asked (its history stays); deletes one that never was. */
  async remove(questionId: string, actor: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const question = await this.getQuestion(questionId, tx);
      if (question.status === 'archived') throw notFound('Question not found');
      const role = await this.roles.getEditableRow(question.jobRoleId, tx);
      // Every attempt belongs to a session question, so this covers attempts too (erased users included).
      const asked =
        (await tx.sessionQuestion.count({ where: { questionId } })) > 0;
      if (asked) {
        await tx.question.update({
          where: { id: questionId },
          data: { status: 'archived' },
        });
      } else {
        await tx.question.delete({ where: { id: questionId } });
      }
      await this.roles.touch(role.id, actor.id, tx);
      await this.record(
        asked ? 'Archived question' : 'Deleted question',
        question,
        role.title,
        actor,
        tx,
      );
    });
  }

  /** Runs the real evaluator on a sample answer (never an Attempt); caches it as `sampleEvaluation`. */
  async test(
    questionId: string,
    answer: string,
    actor: Actor,
  ): Promise<TestEvaluation> {
    const question = await this.getQuestion(questionId, this.prisma);
    if (question.status === 'archived') throw notFound('Question not found');
    const role = await this.roles.getRow(question.jobRoleId);
    await this.quota.consume(actor.id);
    const rubric = question.rubric as Rubric;
    const result = await this.evaluator.evaluate({
      roleTitle: role.title,
      question: question.text,
      rubric,
      transcript: answer,
      mode: 'typed',
      attemptNo: 1,
      dimensionWeights: (role.settings as RoleSettings).dimensionWeights,
    });
    const evaluation = toTestEvaluation(
      answer,
      result.score,
      result.dimensionScores,
      result.output,
      rubric,
    );
    await this.prisma.question.update({
      where: { id: questionId },
      data: {
        sampleEvaluation: evaluation as unknown as Prisma.InputJsonObject,
      },
    });
    return evaluation;
  }

  private async single(question: Question): Promise<AdminQuestion> {
    const stats = await questionStats(this.prisma, question.jobRoleId);
    return toAdminQuestion(question, stats.get(question.id));
  }

  private async getQuestion(
    questionId: string,
    db: PrismaService | Prisma.TransactionClient,
  ): Promise<Question> {
    const question = await db.question.findUnique({
      where: { id: questionId },
    });
    if (!question) throw notFound('Question not found');
    return question;
  }

  /** The linked card must belong to the same role. */
  private async assertCard(
    tx: Prisma.TransactionClient,
    roleId: string,
    cardId: string | null | undefined,
  ): Promise<void> {
    if (!cardId) return;
    const card = await tx.flashCard.findFirst({
      where: { id: cardId, jobRoleId: roleId },
      select: { id: true },
    });
    if (!card) throw validationFailed('cardId: not a flash card of this role');
  }

  private record(
    action: string,
    question: Question,
    roleTitle: string,
    actor: Actor,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    return this.audit.record(
      {
        actorId: actor.id,
        action,
        entity: ENTITY,
        entityId: question.id,
        itemLabel: `${roleTitle} · ${question.text.slice(0, 80)}`,
        ip: actor.ip,
      },
      tx,
    );
  }
}
