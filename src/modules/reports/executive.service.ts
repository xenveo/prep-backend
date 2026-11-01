import { Injectable } from '@nestjs/common';
import { hasAdminAccess } from '../../common/auth/admin-access.js';
import { notFound } from '../../common/errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { executivePeriod, type ExecutivePeriod } from './executive-period.js';
import type {
  ExecutiveCandidatesQuery,
  ExecutiveQuery,
} from './executive.schemas.js';
import {
  executiveCtes,
  pageSql,
  roleSummarySql,
  summarySql,
  type ExecutiveScope,
  type SummaryRow,
} from './executive.sql.js';
import type {
  ExecutiveCandidate,
  ExecutiveCandidates,
  ExecutiveMetadata,
  ExecutiveOverview,
  ExecutiveRole,
  PerformanceSummary,
} from './executive.types.js';

export const EXECUTIVE_LIMITATIONS = [
  'Invitations record issuance, not confirmed email delivery. Acceptance means first sign-in within seven days.',
  'Recruiter attribution is the original inviter, not ongoing ownership. Missing or erased inviters are shown as unknown.',
  'Invites count unique candidates; performance counts candidate–role pairs. The same candidate can contribute several role comparisons.',
  'Assignment transfers and access changes are not fully historized; role membership uses assignments and historical sessions available at cutoff.',
  'Historical results can change after erasure. Repeated questions, rubric changes and prompt changes can affect score comparisons.',
];
export function executiveMetadata(p: ExecutivePeriod): ExecutiveMetadata {
  return {
    period: p.period,
    cohortMonth: p.cohortMonth,
    cutoff: p.cutoff.toISOString(),
    timeZone: 'UTC',
    limitations: [...EXECUTIVE_LIMITATIONS],
  };
}
export function performanceSummary(row?: SummaryRow): PerformanceSummary {
  const den = row?.acceptance_den ?? 0;
  const num = row?.acceptance_num ?? 0;
  return {
    invited: row?.invited ?? 0,
    acceptance: { num, den, value: den ? num / den : null },
    awaitingAcceptanceWindow: row?.awaiting ?? 0,
    assignmentPairs: row?.assignment_pairs ?? 0,
    unassignedCandidates: row?.unassigned ?? 0,
    paired: row?.paired ?? 0,
    first: row?.first ?? null,
    latest: row?.latest ?? null,
    gain: row?.gain ?? null,
    improved: row?.improved ?? 0,
    unchanged: row?.unchanged ?? 0,
    declined: row?.declined ?? 0,
    singleSession: row?.single_session ?? 0,
    unassessed: row?.unassessed ?? 0,
  };
}

@Injectable()
export class ExecutiveService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(
    q: ExecutiveQuery,
    now = new Date(),
  ): Promise<ExecutiveOverview> {
    const p = executivePeriod(q.period, now);
    const scope: ExecutiveScope = { ...p, roleId: q.roleId };
    return this.prisma.$transaction(
      async (tx) => {
        const roles = await this.roles(tx, p, q.roleId);
        const admins = await tx.user.findMany({
          where: {
            ...hasAdminAccess(),
            deletedAt: null,
            createdAt: { lt: p.cutoff },
          },
          select: { id: true, name: true, email: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        const [rows, memberships] = await Promise.all([
          tx.$queryRaw<SummaryRow[]>(summarySql(scope)),
          tx.$queryRaw<{ recruiter_id: string; role_id: string }[]>(
            Prisma.sql`${executiveCtes({ ...p })} SELECT DISTINCT recruiter_id, role_id::text FROM pairs`,
          ),
        ]);
        const recruiters = admins.map((a) => ({
          id: a.id,
          name: a.name?.trim() || a.email,
          roles: memberships
            .filter((m) => m.recruiter_id === a.id)
            .map((m) => m.role_id)
            .sort(),
        }));
        if (rows.some((r) => r.recruiter_id === 'unknown'))
          recruiters.push({
            id: 'unknown',
            name: 'Unknown recruiter',
            roles: memberships
              .filter((m) => m.recruiter_id === 'unknown')
              .map((m) => m.role_id)
              .sort(),
          });
        const current = executivePeriod(undefined, now).start;
        const periods = Array.from({ length: 12 }, (_, i) =>
          new Date(
            Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - i, 1),
          )
            .toISOString()
            .slice(0, 7),
        );
        if (!periods.includes(p.period)) periods.push(p.period);
        return {
          meta: executiveMetadata(p),
          options: { roles, recruiters, periods: periods.sort().reverse() },
          recruiterResults: {
            cohortMonth: p.cohortMonth,
            recruiters: recruiters.map((r) => ({
              ...r,
              ...performanceSummary(rows.find((x) => x.recruiter_id === r.id)),
            })),
            team: performanceSummary(rows.find((r) => r.recruiter_id === null)),
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async candidates(
    q: ExecutiveCandidatesQuery,
    now = new Date(),
  ): Promise<ExecutiveCandidates> {
    const p = executivePeriod(q.period, now);
    const scope: ExecutiveScope = {
      ...p,
      roleId: q.roleId,
      recruiterId: q.recruiterId,
    };
    return this.prisma.$transaction(
      async (tx) => {
        const roles = await this.roles(tx, p, q.roleId);
        if (q.recruiterId && q.recruiterId !== 'unknown') {
          const admin = await tx.user.findFirst({
            where: {
              id: q.recruiterId,
              ...hasAdminAccess(),
              deletedAt: null,
              createdAt: { lt: p.cutoff },
            },
            select: { id: true },
          });
          if (!admin) throw notFound('Recruiter not found');
        }
        const [summaries, roleSummaries, pages] = await Promise.all([
          tx.$queryRaw<SummaryRow[]>(summarySql(scope)),
          tx.$queryRaw<SummaryRow[]>(roleSummarySql(scope)),
          tx.$queryRaw<{ total: number; rows: CandidateRow[] }[]>(
            pageSql(scope, q.search, q.page, q.pageSize),
          ),
        ]);
        return {
          meta: executiveMetadata(p),
          cohortMonth: p.cohortMonth,
          summary: performanceSummary(
            summaries.find((r) => r.recruiter_id === null),
          ),
          roles: roles
            .filter((r) => !q.roleId || r.id === q.roleId)
            .map((r) => ({
              ...r,
              ...performanceSummary(
                roleSummaries.find((x) => x.role_id === r.id),
              ),
            })),
          candidates: (pages[0]?.rows ?? []).map((r) =>
            this.candidate(r, p.cohortMonth),
          ),
          page: q.page,
          pageSize: q.pageSize,
          total: pages[0]?.total ?? 0,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private async roles(
    tx: Prisma.TransactionClient,
    p: ExecutivePeriod,
    roleId?: string,
  ): Promise<ExecutiveRole[]> {
    const roles = await tx.jobRole.findMany({
      where: { createdAt: { lt: p.cutoff } },
      select: { id: true, title: true },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
    });
    if (roleId && !roles.some((r) => r.id === roleId))
      throw notFound('Role not found');
    return roles.map((r) => ({ id: r.id, name: r.title, short: r.title }));
  }

  private candidate(
    row: CandidateRow,
    cohortMonth: string,
  ): ExecutiveCandidate {
    return {
      id: row.id,
      candidateId: row.candidate_id,
      name: row.name,
      recruiterId: row.recruiter_id,
      roleId: row.role_id,
      invitedMonth: cohortMonth,
      accepted: row.accepted,
      sessions: row.sessions,
      firstScore: row.first_score,
      latestScore: row.latest_score,
    };
  }
}
type CandidateRow = {
  id: string;
  candidate_id: string;
  name: string;
  recruiter_id: string;
  role_id: string;
  accepted: boolean;
  sessions: number;
  first_score: number | null;
  latest_score: number | null;
};
