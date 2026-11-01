import { Injectable } from '@nestjs/common';
import { notFound } from '../../common/errors/app-error.js';
import { toAdminBand } from '../../common/mapping/enums.js';
import { Prisma, type Band } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { executivePeriod } from './executive-period.js';
import type { ExecutiveQuery } from './executive.schemas.js';
import type {
  ExecutiveBands,
  ExecutiveFlagType,
  ExecutiveInsights,
  ExecutiveRatio,
} from './executive.types.js';

const DAY = 86_400_000;
const DIMENSIONS = ['content', 'structure', 'delivery', 'relevance'] as const;
const ratio = (num: number, den: number): ExecutiveRatio => ({
  num,
  den,
  value: den ? num / den : null,
});
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const bands = (): ExecutiveBands => ({
  ready: 0,
  nearly: 0,
  developing: 0,
  not_ready: 0,
});
const utc = (date: Date) =>
  Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

type CohortCandidate = { id: string; sentAt: Date; firstLoginAt: Date | null };

type SessionRow = {
  id: string;
  userId: string;
  jobRoleId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  score: number | null;
  band: Band | null;
  _count: { attempts: number };
};

type AssignmentRow = {
  userId: string;
  jobRoleId: string;
  assignedAt: Date;
  removedAt: Date | null;
  user: {
    name: string | null;
    email: string;
    status: string;
    lastActiveAt: Date | null;
    accessExpiresAt: Date | null;
  };
};

/** Read-only supporting metrics. The primary executive questions use ExecutiveService. */
@Injectable()
export class ExecutiveInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    query: ExecutiveQuery,
    now = new Date(),
  ): Promise<ExecutiveInsights> {
    return this.prisma.$transaction((db) => this.readReport(db, query, now), {
      isolationLevel: 'RepeatableRead',
    });
  }

  private async readReport(
    db: Prisma.TransactionClient,
    query: ExecutiveQuery,
    now: Date,
  ): Promise<ExecutiveInsights> {
    const period = executivePeriod(query.period, now);
    const { start, cutoff, cohortStart, cohortEnd } = period;
    const roleWhere = query.roleId ? { id: query.roleId } : {};
    const roleRows = await db.jobRole.findMany({
      where: { ...roleWhere, createdAt: { lt: cutoff } },
      select: { id: true, title: true },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
    });
    if (query.roleId && !roleRows.length) throw notFound('Role not found');
    const roles = roleRows.map((r) => ({
      id: r.id,
      name: r.title,
      short: r.title,
    }));
    const roleIds = roles.map((r) => r.id);
    const userWhere = { role: 'candidate' as const, deletedAt: null };
    const sessionWhere = {
      jobRoleId: { in: roleIds },
      isPreview: false,
      user: userWhere,
      startedAt: { lt: cutoff },
    };
    const [sessions, assignments, attempts, flags, cohort] = await Promise.all([
      db.session.findMany({
        where: sessionWhere,
        select: {
          id: true,
          userId: true,
          jobRoleId: true,
          status: true,
          startedAt: true,
          completedAt: true,
          score: true,
          band: true,
          _count: {
            select: { attempts: { where: { submittedAt: { lt: cutoff } } } },
          },
        },
        orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      }),
      db.roleAssignment.findMany({
        where: {
          jobRoleId: { in: roleIds },
          assignedAt: { lt: cutoff },
          user: userWhere,
        },
        select: {
          userId: true,
          jobRoleId: true,
          assignedAt: true,
          removedAt: true,
          user: {
            select: {
              name: true,
              email: true,
              status: true,
              lastActiveAt: true,
              accessExpiresAt: true,
            },
          },
        },
      }),
      db.attempt.findMany({
        where: {
          status: 'done',
          score: { not: null },
          submittedAt: { gte: start, lt: cutoff },
          session: {
            ...sessionWhere,
            status: 'completed',
            completedAt: { lt: cutoff },
            score: { not: null },
          },
        },
        select: {
          questionId: true,
          attemptNo: true,
          score: true,
          dimensionScores: true,
          question: { select: { text: true } },
        },
      }),
      db.evaluationFlag.findMany({
        where: { createdAt: { gte: start, lt: cutoff }, session: sessionWhere },
        select: { issue: true, createdAt: true, resolvedAt: true },
      }),
      this.invitationCohort(db, query.roleId, cohortStart, cohortEnd, cutoff),
    ]);
    const completed = sessions.filter(
      (s) =>
        s.status === 'completed' &&
        s.score !== null &&
        s.completedAt !== null &&
        s.completedAt < cutoff,
    );
    const byPair = new Map<string, SessionRow[]>();
    for (const session of completed) {
      const key = `${session.userId}:${session.jobRoleId}`;
      const existing = byPair.get(key) ?? [];
      existing.push(session);
      byPair.set(key, existing);
    }
    // Prisma order is chronological, but keep the derivation deterministic for injected test rows.
    for (const pair of byPair.values())
      pair.sort(
        (a, b) =>
          a.completedAt!.getTime() - b.completedAt!.getTime() ||
          a.id.localeCompare(b.id),
      );
    const assignmentMap = new Map(
      assignments.map((a) => [`${a.userId}:${a.jobRoleId}`, a]),
    );
    const historical = period.monthEnd <= now;
    const pipeline = roles.map((role) => {
      const out = { role, bands: bands(), unassessed: 0, newlyReady: 0 };
      const keys = new Set<string>();
      for (const [key, pair] of byPair)
        if (pair[0]!.jobRoleId === role.id) keys.add(key);
      for (const [key, assignment] of assignmentMap)
        if (
          assignment.jobRoleId === role.id &&
          (!assignment.removedAt || assignment.removedAt >= cutoff)
        )
          keys.add(key);
      for (const key of keys) {
        const pair = byPair.get(key) ?? [];
        const latest = pair.at(-1);
        if (latest?.band) out.bands[toAdminBand(latest.band)]++;
        else out.unassessed++;
        const ready = pair.find((s) => s.band === 'interview_ready');
        if (ready?.completedAt && ready.completedAt >= start) out.newlyReady++;
      }
      return out;
    });
    const cohortById = new Map(
      cohort.map((candidate) => [candidate.id, candidate]),
    );
    const activationEligible = cohort.filter(
      (c) => c.sentAt.getTime() + 7 * DAY <= cutoff.getTime(),
    );
    const activated = (c: CohortCandidate) =>
      c.firstLoginAt !== null &&
      c.firstLoginAt >= c.sentAt &&
      c.firstLoginAt.getTime() <= c.sentAt.getTime() + 7 * DAY &&
      c.firstLoginAt < cutoff;
    const practiceEligible = cohort.filter(
      (c) =>
        activated(c) && c.firstLoginAt!.getTime() + 7 * DAY <= cutoff.getTime(),
    );
    const firstByUser = new Map<string, SessionRow>();
    for (const s of completed) {
      if (!cohortById.has(s.userId)) continue;
      const before = firstByUser.get(s.userId);
      if (!before || s.completedAt! < before.completedAt!)
        firstByUser.set(s.userId, s);
    }
    const practiced = practiceEligible.filter((c) => {
      const first = firstByUser.get(c.id)?.completedAt;
      return (
        first != null &&
        first >= c.firstLoginAt! &&
        first.getTime() <= c.firstLoginAt!.getTime() + 7 * DAY
      );
    });
    const repeatPairs = [...byPair.values()].filter(
      (pair) =>
        cohortById.has(pair[0]!.userId) &&
        pair[0]!.completedAt!.getTime() + 14 * DAY <= cutoff.getTime(),
    );
    const repeated = repeatPairs.filter(
      (pair) =>
        pair[1]?.completedAt &&
        pair[1].completedAt.getTime() <=
          pair[0]!.completedAt!.getTime() + 14 * DAY,
    );
    const daysToReady: number[] = [];
    let attainmentEligible = 0;
    let attained = 0;
    for (const pair of byPair.values()) {
      const first = pair[0]!.completedAt!;
      const ready = pair.find((s) => s.band === 'interview_ready')?.completedAt;
      if (ready && ready >= start)
        daysToReady.push((ready.getTime() - first.getTime()) / DAY);
      if (first.getTime() + 60 * DAY <= cutoff.getTime()) {
        attainmentEligible++;
        if (ready && ready.getTime() <= first.getTime() + 60 * DAY) attained++;
      }
    }
    const firstAttempts = attempts.filter((a) => a.attemptNo === 1);
    const dimensions = DIMENSIONS.map((id) => ({
      id,
      label: `${id[0]!.toUpperCase()}${id.slice(1)}`,
      value: mean(
        firstAttempts.flatMap((a) => {
          const values = a.dimensionScores;
          if (!values || typeof values !== 'object' || Array.isArray(values))
            return [];
          const value = values[id];
          return typeof value === 'number' && Number.isFinite(value)
            ? [value]
            : [];
        }),
      ),
    }));
    const questionMap = new Map<
      string,
      { id: string; question: string; first: number[]; retry: number[] }
    >();
    for (const a of attempts) {
      const row = questionMap.get(a.questionId) ?? {
        id: a.questionId,
        question: a.question.text,
        first: [],
        retry: [],
      };
      if (a.attemptNo === 1) row.first.push(a.score!);
      if (a.attemptNo === 2) row.retry.push(a.score!);
      questionMap.set(a.questionId, row);
    }
    const hardestQuestions = [...questionMap.values()]
      .filter((r) => r.first.length > 0)
      .map((r) => ({
        id: r.id,
        question: r.question,
        responses: r.first.length,
        first: mean(r.first),
        retry: mean(r.retry),
      }))
      .sort((a, b) => a.first! - b.first! || a.id.localeCompare(b.id))
      .slice(0, 5);
    const cases: ExecutiveInsights['attention']['cases'] = [];
    for (const a of assignments as AssignmentRow[]) {
      if (
        (a.removedAt !== null && a.removedAt < cutoff) ||
        a.user.status === 'invite_pending' ||
        a.user.status === 'revoked' ||
        (a.user.accessExpiresAt && a.user.accessExpiresAt <= cutoff)
      )
        continue;
      const latest = byPair.get(`${a.userId}:${a.jobRoleId}`)?.at(-1);
      const low = latest?.score != null && latest.score < 50;
      const inactive =
        !historical &&
        a.user.lastActiveAt !== null &&
        a.user.lastActiveAt.getTime() <= cutoff.getTime() - 14 * DAY;
      if (!low && !inactive) continue;
      cases.push({
        candidateId: a.userId,
        name: a.user.name?.trim() || a.user.email,
        roleId: a.jobRoleId,
        roleName: roles.find((r) => r.id === a.jobRoleId)!.name,
        score: latest?.score ?? null,
        reason: low && inactive ? 'both' : low ? 'low' : 'inactive',
      });
    }
    cases.sort(
      (a, b) =>
        (a.score ?? Infinity) - (b.score ?? Infinity) ||
        a.name.localeCompare(b.name) ||
        a.roleId.localeCompare(b.roleId),
    );
    const started = sessions.filter(
      (s) => s.startedAt >= start && s._count.attempts > 0,
    );
    const finished = started.filter(
      (s) =>
        s.status === 'completed' &&
        s.completedAt !== null &&
        s.completedAt < cutoff,
    );
    const abandoned = started.filter((s) => s.status === 'abandoned');
    const completedInPeriod = completed.filter(
      (s) => s.completedAt! >= start,
    ).length;
    const byType: Record<ExecutiveFlagType, number> = {
      too_high: 0,
      too_low: 0,
      feedback: 0,
      transcript: 0,
    };
    const flagType: Record<string, ExecutiveFlagType> = {
      too_high: 'too_high',
      too_low: 'too_low',
      feedback_inaccurate: 'feedback',
      transcript_wrong: 'transcript',
    };
    const resolutionHours: number[] = [];
    let unresolved = 0;
    for (const flag of flags) {
      const type = flagType[flag.issue];
      if (type) byType[type]++;
      if (
        flag.resolvedAt &&
        flag.resolvedAt < cutoff &&
        flag.resolvedAt >= flag.createdAt
      )
        resolutionHours.push(
          (flag.resolvedAt.getTime() - flag.createdAt.getTime()) / 3_600_000,
        );
      else unresolved++;
    }
    return {
      meta: {
        period: period.period,
        cohortMonth: period.cohortMonth,
        cutoff: cutoff.toISOString(),
        timeZone: 'UTC',
        limitations: [
          'Assignment transfers, access changes and user status are not fully historized; historical snapshots use currently available records and can change after erasure.',
          'Historical inactivity is unavailable because lastActiveAt is mutable; current inactivity reflects signed-in activity, not practice alone.',
          'Session abandonment has no event timestamp, so historical abandonment reflects current recorded status. Unfinished sessions are reported separately.',
          'Readiness uses stored bands; scored sessions without a stored band have no readiness assessment.',
          'Time-to-readiness attainment is measured within 60 days of first completed practice, using only pairs with a full 60-day observation window.',
          'Coaching scores use first attempts submitted in the reporting period on sessions completed before cutoff; question and rubric edits are not snapshotted.',
          'Attention cases are limited to the first 50 candidate–role pairs; counts cover all matching pairs.',
        ],
      },
      funnel: {
        invited: cohort.length,
        activation: ratio(
          activationEligible.filter(activated).length,
          activationEligible.length,
        ),
        firstPractice: ratio(practiced.length, practiceEligible.length),
        repeatPractice: ratio(repeated.length, repeatPairs.length),
      },
      pipeline,
      timeToReady: {
        medianDays: median(daysToReady),
        attainment: ratio(attained, attainmentEligible),
      },
      dimensions,
      hardestQuestions,
      attention: {
        total: cases.length,
        low: cases.filter((c) => c.reason === 'low').length,
        inactive: cases.filter((c) => c.reason === 'inactive').length,
        both: cases.filter((c) => c.reason === 'both').length,
        historicalInactivityAvailable: !historical,
        cases: cases.slice(0, 50),
      },
      quality: {
        completion: ratio(finished.length, started.length),
        sessions: {
          started: started.length,
          completed: finished.length,
          abandoned: abandoned.length,
          unfinished: started.length - finished.length - abandoned.length,
        },
        flagRate: completedInPeriod
          ? (flags.length / completedInPeriod) * 100
          : null,
        resolutionHours: median(resolutionHours),
        flags: { total: flags.length, unresolved, byType },
      },
      unavailable: [
        {
          metric: 'Recruiter review coverage',
          reason:
            'Explicit review events and responsibility history are not recorded.',
        },
        {
          metric: 'At-risk follow-up compliance',
          reason:
            'Risk episodes, deadlines and structured human follow-up events are not recorded.',
        },
        {
          metric: 'Candidate satisfaction',
          reason:
            'Milestone survey invitations and responses are not recorded.',
        },
        {
          metric: 'Feedback delivery success',
          reason:
            'A feedback-ready timestamp and preserved submission history are not recorded.',
        },
        {
          metric: 'Real interview outcomes',
          reason:
            'Outcomes are not collected; a separate product and data-purpose decision is required.',
        },
      ],
    };
  }

  private invitationCohort(
    db: Prisma.TransactionClient,
    roleId: string | undefined,
    start: Date,
    end: Date,
    cutoff: Date,
  ): Promise<CohortCandidate[]> {
    const roleFilter = roleId
      ? Prisma.sql`AND (
      EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.user_id = u.id AND ra.job_role_id = ${roleId}::uuid AND ra.assigned_at < ${utc(cutoff)})
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.job_role_id = ${roleId}::uuid AND NOT s.is_preview AND s.started_at < ${utc(cutoff)})
    )`
      : Prisma.empty;
    return db.$queryRaw<CohortCandidate[]>`
      WITH first_invites AS (
        SELECT DISTINCT ON (i.user_id) i.user_id, i.sent_at
        FROM invites i ORDER BY i.user_id, i.sent_at, i.id
      )
      SELECT u.id::text AS id, f.sent_at AS "sentAt", u.first_login_at AS "firstLoginAt"
      FROM first_invites f JOIN users u ON u.id = f.user_id
      WHERE u.deleted_at IS NULL AND u.role = 'candidate'
        AND f.sent_at >= ${utc(start)} AND f.sent_at < ${utc(end)}
        ${roleFilter}`;
  }
}
