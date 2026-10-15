import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { toCandidateBand } from '../../common/mapping/enums.js';
import type { JobRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ContentQueryService } from '../content/content-query.service.js';
import {
  type AssignmentStats,
  AssignmentsService,
} from '../users/assignments.service.js';
import type {
  CandidateRole,
  CandidateRoleStatus,
  HistoryItem,
  RoleDetail,
  RoleWithStatus,
} from './interview.schemas.js';
import { toSessionSummary } from './serializers/candidate.serializer.js';
import { isUuid, roleSettings } from './sessions.service.js';
import type { SessionSummary } from './types.js';

const COMPLETED_SUMMARY = {
  id: true,
  number: true,
  startedAt: true,
  score: true,
  band: true,
  role: { select: { slug: true } },
} as const;

/** Candidate dashboard, role shell, progress and history (spec "Candidate API"). */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly content: ContentQueryService,
  ) {}

  /** GET /roles: the user's assigned approved roles with derived status (SRS 5.6). */
  async listRoles(user: AuthUser): Promise<RoleWithStatus[]> {
    const [roles, stats, inProgress] = await Promise.all([
      this.assignments.listCandidateRoles(user.id),
      this.assignments.getStatsForUser(user.id),
      this.prisma.session.findMany({
        where: { userId: user.id, status: 'in_progress', isPreview: false },
        select: { jobRoleId: true, currentQuestion: true },
      }),
    ]);
    const statsFor = new Map(stats.map((s) => [s.jobRoleId, s]));
    const currentFor = new Map(
      inProgress.map((s) => [s.jobRoleId, s.currentQuestion]),
    );
    return Promise.all(
      roles.map(async ({ assignment, role }) => {
        const [base, viewed] = await Promise.all([
          this.toRole(role),
          this.content.viewedApprovedCardCount(user.id, role.id),
        ]);
        const s = statsFor.get(role.id) ?? null;
        const current = currentFor.get(role.id);
        return {
          ...base,
          status: deriveStatus(
            current === undefined
              ? null
              : Math.min(current, base.questionCount),
            s,
            viewed,
          ),
          latest: s?.latestScore ?? null,
          bestBand: s?.bestBand ? toCandidateBand(s.bestBand) : null,
          latestBand: s?.latestBand ? toCandidateBand(s.latestBand) : null,
          attemptsLeft: this.assignments.attemptsLeft(assignment, role, s),
          accessExpiresAt: user.accessExpiresAt?.toISOString() ?? null,
        };
      }),
    );
  }

  /** GET /roles/:roleId: the role plus the settings the candidate UI needs. */
  async getRole(userId: string, roleRef: string): Promise<RoleDetail> {
    const { role } = await this.assignments.findCandidateRole(userId, roleRef);
    const settings = roleSettings(role);
    return {
      ...(await this.toRole(role)),
      cardsRequired: settings.requireAllCards,
      questionsPerSession: settings.questionsPerSession,
      answerSoftLimitSec: settings.answerGuideSeconds || 120,
      retriesPerQuestion: 1,
    };
  }

  /** GET /roles/:roleId/sessions: completed sessions, oldest first (progress chart, baseline). */
  async listRoleSessions(
    userId: string,
    roleRef: string,
  ): Promise<SessionSummary[]> {
    const { role } = await this.assignments.findCandidateRole(userId, roleRef);
    const rows = await this.prisma.session.findMany({
      where: {
        userId,
        jobRoleId: role.id,
        status: 'completed',
        isPreview: false,
      },
      orderBy: { number: 'asc' },
      select: COMPLETED_SUMMARY,
    });
    return rows.map(toSessionSummary);
  }

  /** GET /sessions?roleId=: completed sessions, newest first. `roleId` is a slug or uuid. */
  async history(userId: string, roleRef?: string): Promise<HistoryItem[]> {
    const roleWhere = roleRef
      ? isUuid(roleRef)
        ? { jobRoleId: roleRef }
        : { role: { slug: roleRef } }
      : {};
    const rows = await this.prisma.session.findMany({
      where: { userId, status: 'completed', isPreview: false, ...roleWhere },
      orderBy: { completedAt: 'desc' },
      select: COMPLETED_SUMMARY,
    });
    return rows.map((r) => ({ ...toSessionSummary(r), roleId: r.role.slug }));
  }

  private async toRole(role: JobRole): Promise<CandidateRole> {
    return {
      id: role.slug,
      name: role.title,
      blurb: role.blurb,
      cardCount: await this.content.approvedCardCount(role.id),
      questionCount: roleSettings(role).questionsPerSession,
    };
  }
}

/** In progress → interviewing; else completed → completed; else cards viewed → studying. */
export function deriveStatus(
  currentQuestion: number | null,
  stats: Pick<
    AssignmentStats,
    'sessionsCompleted' | 'bestScore' | 'baselineScore'
  > | null,
  viewedCards: number,
): CandidateRoleStatus {
  if (currentQuestion !== null) {
    return { kind: 'interviewing', question: currentQuestion };
  }
  if (stats && stats.sessionsCompleted > 0 && stats.bestScore !== null) {
    return {
      kind: 'completed',
      score: stats.bestScore,
      // The baseline is shown only once there is a later session to compare it with.
      baseline: stats.sessionsCompleted >= 2 ? stats.baselineScore : null,
    };
  }
  if (viewedCards > 0) return { kind: 'studying', viewed: viewedCards };
  return { kind: 'not-started' };
}
