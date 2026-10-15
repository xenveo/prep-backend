import { Injectable } from '@nestjs/common';
import { notFound } from '../../common/errors/app-error.js';
import type {
  Band,
  JobRole,
  RoleAssignment,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type AssignmentStats = {
  assignmentId: string;
  userId: string;
  jobRoleId: string;
  /** In-progress plus completed sessions (previews excluded): counts against the attempt limit. */
  sessionsUsed: number;
  sessionsCompleted: number;
  baselineScore: number | null;
  latestScore: number | null;
  latestBand: Band | null;
  bestScore: number | null;
  bestBand: Band | null;
  /** latest − baseline; null until two sessions are complete. */
  change: number | null;
  lastCompletedAt: Date | null;
};

export type CandidateRole = { assignment: RoleAssignment; role: JobRole };

type StatsRow = {
  assignment_id: string;
  user_id: string;
  job_role_id: string;
  sessions_used: number | bigint;
  sessions_completed: number | bigint;
  baseline_score: number | null;
  latest_score: number | null;
  latest_band: string | null;
  best_score: number | null;
  best_band: string | null;
  change: number | null;
  last_completed_at: Date | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Candidate-side role assignments. A role the candidate isn't assigned to, or that isn't approved,
 * is reported as 404 (never 403) so its existence isn't revealed (spec "UI vs SRS gaps").
 */
@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** `roleRef` is a job role slug (the candidate UI's role id) or uuid. Throws 404. */
  async findCandidateRole(
    userId: string,
    roleRef: string,
  ): Promise<CandidateRole> {
    const roleWhere = UUID_RE.test(roleRef)
      ? { id: roleRef }
      : { slug: roleRef };
    const row = await this.prisma.roleAssignment.findFirst({
      where: {
        userId,
        removedAt: null,
        user: { deletedAt: null },
        role: { ...roleWhere, status: 'approved' },
      },
      include: { role: true },
    });
    if (!row) throw notFound('Role not found');
    const { role, ...assignment } = row;
    return { assignment, role };
  }

  /** Every live assignment to an approved role, by role title. */
  async listCandidateRoles(userId: string): Promise<CandidateRole[]> {
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        userId,
        removedAt: null,
        user: { deletedAt: null },
        role: { status: 'approved' },
      },
      include: { role: true },
      orderBy: { role: { title: 'asc' } },
    });
    return rows.map(({ role, ...assignment }) => ({ assignment, role }));
  }

  async getStats(
    userId: string,
    jobRoleId: string,
  ): Promise<AssignmentStats | null> {
    const rows = await this.prisma.$queryRaw<StatsRow[]>`
      SELECT assignment_id::text, user_id::text, job_role_id::text, sessions_used, sessions_completed,
             baseline_score, latest_score, latest_band::text, best_score, best_band::text, change, last_completed_at
      FROM "assignment_stats"
      WHERE user_id = ${userId}::uuid AND job_role_id = ${jobRoleId}::uuid`;
    return rows[0] ? toStats(rows[0]) : null;
  }

  async getStatsForUser(userId: string): Promise<AssignmentStats[]> {
    const rows = await this.prisma.$queryRaw<StatsRow[]>`
      SELECT assignment_id::text, user_id::text, job_role_id::text, sessions_used, sessions_completed,
             baseline_score, latest_score, latest_band::text, best_score, best_band::text, change, last_completed_at
      FROM "assignment_stats"
      WHERE user_id = ${userId}::uuid`;
    return rows.map(toStats);
  }

  /** Sessions the candidate may still start: the assignment's own limit, else the role's. null = unlimited. */
  attemptsLeft(
    assignment: Pick<RoleAssignment, 'maxAttempts'>,
    role: Pick<JobRole, 'settings'>,
    stats: Pick<AssignmentStats, 'sessionsUsed'> | null,
  ): number | null {
    const roleLimit = (
      role.settings as { maxSessionsPerCandidate?: number | null } | null
    )?.maxSessionsPerCandidate;
    const limit = assignment.maxAttempts ?? roleLimit ?? null;
    if (limit === null) return null;
    return Math.max(0, limit - (stats?.sessionsUsed ?? 0));
  }
}

const num = (v: number | bigint | null): number | null =>
  v === null ? null : Number(v);

function toStats(r: StatsRow): AssignmentStats {
  return {
    assignmentId: r.assignment_id,
    userId: r.user_id,
    jobRoleId: r.job_role_id,
    sessionsUsed: Number(r.sessions_used),
    sessionsCompleted: Number(r.sessions_completed),
    baselineScore: num(r.baseline_score),
    latestScore: num(r.latest_score),
    latestBand: r.latest_band as Band | null,
    bestScore: num(r.best_score),
    bestBand: r.best_band as Band | null,
    change: num(r.change),
    lastCompletedAt: r.last_completed_at,
  };
}
