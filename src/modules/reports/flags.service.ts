import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  conflict,
  notFound,
  validationFailed,
} from '../../common/errors/app-error.js';
import type { EvaluationFlag } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { FlagInput, ResolveFlagInput } from './reports.schemas.js';
import type {
  EvaluationFlagView,
  FlagDimension,
  FlagIssue,
} from './reports.types.js';

export const FLAG_DIMENSION_LABEL: Record<FlagDimension, string> = {
  content: 'Content',
  structure: 'Structure',
  delivery: 'Delivery',
  relevance: 'Relevance',
  overall: 'Overall',
  feedback: 'Feedback',
};

/** "Session 2 · Q4 · Delivery" */
export const flagTitle = (
  sessionNumber: number,
  questionNumber: number,
  dimension: FlagDimension,
) =>
  `Session ${sessionNumber} · Q${questionNumber} · ${FLAG_DIMENSION_LABEL[dimension]}`;

/** Audit strings: the admin UI's (sessions.ts) for submit; resolve has no UI yet. */
export const FLAG_AUDIT = {
  submit: 'Flagged an evaluation',
  resolve: 'Resolved an evaluation flag',
} as const;

type Actor = { id: string; ip: string | null };

/**
 * Evaluation flags (FR-REP-05). A flag is a note for rubric review: it never changes a score.
 * Only real (non-preview) sessions of non-erased candidates can be flagged or listed.
 */
@Injectable()
export class FlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Flag history, newest first. */
  async list(sessionId: string): Promise<EvaluationFlagView[]> {
    const session = await this.findSession(sessionId);
    const flags = await this.prisma.evaluationFlag.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });
    return this.toViews(flags, session.number);
  }

  async submit(
    sessionId: string,
    input: FlagInput,
    actor: Actor,
  ): Promise<EvaluationFlagView> {
    if (input.sessionId && input.sessionId !== sessionId)
      throw validationFailed('sessionId: does not match the URL');
    const session = await this.findSession(sessionId);
    const sq = await this.prisma.sessionQuestion.findUnique({
      where: {
        sessionId_position: { sessionId, position: input.questionNumber },
      },
      select: { questionId: true },
    });
    if (!sq)
      throw validationFailed('questionNumber: no such question in the session');

    const flag = await this.prisma.$transaction(async (tx) => {
      const created = await tx.evaluationFlag.create({
        data: {
          sessionId,
          questionId: sq.questionId,
          questionNumber: input.questionNumber,
          dimension: input.dimension,
          issue: input.issue,
          note: input.note?.trim() ?? '',
          createdBy: actor.id,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: FLAG_AUDIT.submit,
          entity: 'session',
          entityId: sessionId,
          itemLabel: `${session.candidateName} · session ${session.number} · question ${input.questionNumber}`,
          after: {
            flagId: created.id,
            candidateId: session.userId,
            dimension: input.dimension,
            issue: input.issue,
          },
          ip: actor.ip,
        },
        tx,
      );
      return created;
    });
    const [view] = await this.toViews([flag], session.number);
    return view;
  }

  async resolve(
    flagId: string,
    input: ResolveFlagInput,
    actor: Actor,
  ): Promise<EvaluationFlagView> {
    const existing = await this.prisma.evaluationFlag.findFirst({
      where: {
        id: flagId,
        session: { isPreview: false, user: { deletedAt: null } },
      },
    });
    if (!existing) throw notFound('Flag not found');
    if (existing.status === 'resolved')
      throw conflict('This flag is already resolved');
    const session = await this.findSession(existing.sessionId);

    const flag = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.evaluationFlag.update({
        where: { id: flagId },
        data: {
          status: 'resolved',
          resolution: input.resolution,
          resolvedBy: actor.id,
          resolvedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: FLAG_AUDIT.resolve,
          entity: 'session',
          entityId: existing.sessionId,
          itemLabel: `${session.candidateName} · session ${session.number} · question ${existing.questionNumber}`,
          before: { flagId, status: existing.status },
          after: {
            flagId,
            candidateId: session.userId,
            status: 'resolved',
            resolution: input.resolution,
          },
          ip: actor.ip,
        },
        tx,
      );
      return updated;
    });
    const [view] = await this.toViews([flag], session.number);
    return view;
  }

  private async findSession(sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, isPreview: false, user: { role: 'candidate' } },
      select: {
        number: true,
        userId: true,
        user: { select: { name: true, email: true } },
      },
    });
    if (!session) throw notFound('Session not found');
    return {
      number: session.number,
      userId: session.userId,
      candidateName: session.user.name?.trim() || session.user.email,
    };
  }

  private async toViews(
    flags: EvaluationFlag[],
    sessionNumber: number,
  ): Promise<EvaluationFlagView[]> {
    const ids = [...new Set(flags.map((f) => f.createdBy))];
    const admins = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    const nameOf = new Map(
      admins.map((a) => [a.id, a.name?.trim() || a.email]),
    );
    return flags.map((f) => ({
      id: f.id,
      sessionId: f.sessionId,
      title: flagTitle(
        sessionNumber,
        f.questionNumber,
        f.dimension as FlagDimension,
      ),
      questionNumber: f.questionNumber,
      dimension: f.dimension as FlagDimension,
      ...(f.issue && { issue: f.issue as FlagIssue }),
      note: f.note ?? '',
      createdBy: f.createdBy,
      createdByName: nameOf.get(f.createdBy) ?? 'An admin',
      createdAt: f.createdAt.toISOString(),
      status: f.status,
      ...(f.resolution && { resolution: f.resolution }),
    }));
  }
}
