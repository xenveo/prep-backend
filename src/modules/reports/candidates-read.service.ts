import { Injectable } from '@nestjs/common';
import { toAdminBand } from '../../common/mapping/enums.js';
import { notFound } from '../../common/errors/app-error.js';
import type {
  Band,
  RoleStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import {
  DEFAULT_ROLE_SETTINGS,
  type RoleSettings,
} from '../interview/types.js';
import { AssignmentsService } from '../users/assignments.service.js';
import {
  candidateCsvRows,
  matchesQuery,
  progressByRole,
  sortRows,
} from './candidate-rules.js';
import { toCsv } from './csv.js';
import { inviteSentLabel, relativeTime } from './format.js';
import type { CandidateQuery } from './reports.schemas.js';
import type {
  CandidateDetail,
  CandidateList,
  CandidateRow,
  RoleRef,
} from './reports.types.js';

type CandidateSqlRow = {
  id: string;
  name: string | null;
  email: string;
  status: UserStatus;
  last_active_at: Date | null;
  invited_at: Date | null;
  sessions: number;
  latest_score: number | null;
  latest_band: Band | null;
  change: number | null;
};

const displayName = (u: { name: string | null; email: string }) =>
  u.name?.trim() || u.email;

/**
 * Admin candidate list, detail and CSV (spec "Me and candidates"; FR-REP-01, FR-REP-04).
 * Per-candidate numbers come from the `assignment_stats` view (previews and erased users excluded):
 * sessions = completed sessions over all roles; latest score, band and change are those of the role
 * practised most recently.
 */
@Injectable()
export class CandidatesReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly activity: ActivityService,
  ) {}

  async list(query: CandidateQuery, now = new Date()): Promise<CandidateList> {
    const all = await this.rows(now);
    const rows = sortRows(
      all.filter((r) => matchesQuery(r, query, now)),
      query.sort,
      query.dir,
    );
    return { rows, total: rows.length, totalUnfiltered: all.length };
  }

  /** candidates.csv for the given ids, or every candidate when `ids` is empty. */
  async exportCsv(ids: string[], now = new Date()): Promise<string> {
    const all = await this.rows(now);
    const picked = ids.length ? all.filter((r) => ids.includes(r.id)) : all;
    return toCsv(candidateCsvRows(sortRows(picked, 'name', 'asc')));
  }

  async detail(id: string): Promise<CandidateDetail> {
    const user = await this.prisma.user.findFirst({
      where: { id, role: 'candidate' },
      include: {
        invites: { orderBy: { sentAt: 'desc' }, take: 1 },
        assignments: {
          where: { removedAt: null },
          include: { role: true },
          orderBy: { assignedAt: 'asc' },
        },
      },
    });
    if (!user) throw notFound('Candidate not found');

    const [stats, sessions, activity] = await Promise.all([
      this.assignments.getStatsForUser(id),
      this.prisma.session.findMany({
        where: {
          userId: id,
          isPreview: false,
          status: 'completed',
          score: { not: null },
        },
        include: { role: { select: { title: true } } },
        orderBy: [{ completedAt: 'desc' }, { number: 'desc' }],
      }),
      this.activity.list(id),
    ]);

    const invite = user.invites[0];
    const inviter = invite?.invitedBy
      ? await this.prisma.user.findFirst({
          where: { id: invite.invitedBy },
          select: { name: true, email: true },
        })
      : null;

    const summaries = sessions.map((s) => ({
      id: s.id,
      candidateId: id,
      roleId: s.jobRoleId,
      roleTitle: s.role.title,
      number: s.number,
      date: (s.completedAt ?? s.startedAt).toISOString(),
      score: s.score!,
      band: toAdminBand(s.band!),
      durationMin: Math.round((s.durationS ?? 0) / 60),
    }));

    return {
      id: user.id,
      name: displayName(user),
      email: user.email,
      status: user.status,
      invitedAt: (invite?.sentAt ?? user.createdAt).toISOString(),
      invitedBy: invite?.invitedBy ?? '',
      invitedByName: inviter ? displayName(inviter) : 'an admin',
      ...(user.firstLoginAt && {
        firstLoginAt: user.firstLoginAt.toISOString(),
      }),
      lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
      accessUntil: user.accessExpiresAt?.toISOString() ?? null,
      assignments: user.assignments.map((a) => {
        const st = stats.find((x) => x.assignmentId === a.id);
        const settings = a.role.settings as Partial<RoleSettings> | null;
        const roleLimit =
          settings?.maxSessionsPerCandidate === undefined
            ? DEFAULT_ROLE_SETTINGS.maxSessionsPerCandidate
            : settings.maxSessionsPerCandidate;
        return {
          roleId: a.jobRoleId,
          roleTitle: a.role.title,
          roleStatus: a.role.status,
          assignedAt: a.assignedAt.toISOString(),
          maxSessions: a.maxAttempts ?? roleLimit,
          sessionsUsed: st?.sessionsUsed ?? 0,
          baselineScore: st?.baselineScore ?? null,
          latestScore: st?.latestScore ?? null,
          latestBand: st?.latestBand ? toAdminBand(st.latestBand) : null,
          changeSinceBaseline: st?.change ?? null,
        };
      }),
      sessions: summaries,
      activity,
      progress: progressByRole([...summaries].reverse()),
    };
  }

  /** Every non-erased candidate as a list row. */
  private async rows(now: Date): Promise<CandidateRow[]> {
    const [sqlRows, assignments] = await Promise.all([
      this.prisma.$queryRaw<CandidateSqlRow[]>`
        SELECT u."id"::text, u."name", u."email"::text, u."status"::text, u."last_active_at",
               inv."invited_at",
               COALESCE(tot."sessions", 0)::int AS "sessions",
               lat."latest_score", lat."latest_band"::text, lat."change"
        FROM "users" u
        LEFT JOIN LATERAL (
          SELECT MAX(i."sent_at") AS "invited_at" FROM "invites" i WHERE i."user_id" = u."id"
        ) inv ON true
        LEFT JOIN LATERAL (
          SELECT SUM(st."sessions_completed") AS "sessions"
          FROM "assignment_stats" st WHERE st."user_id" = u."id"
        ) tot ON true
        LEFT JOIN LATERAL (
          SELECT st."latest_score", st."latest_band", st."change"
          FROM "assignment_stats" st
          WHERE st."user_id" = u."id" AND st."sessions_completed" > 0
          ORDER BY st."last_completed_at" DESC
          LIMIT 1
        ) lat ON true
        WHERE u."role" = 'candidate' AND u."deleted_at" IS NULL`,
      this.prisma.roleAssignment.findMany({
        where: { removedAt: null, user: { role: 'candidate' } },
        select: {
          userId: true,
          role: { select: { id: true, title: true, status: true } },
        },
        orderBy: { assignedAt: 'asc' },
      }),
    ]);

    const rolesByUser = new Map<string, RoleRef[]>();
    for (const a of assignments) {
      const list = rolesByUser.get(a.userId) ?? [];
      list.push({
        id: a.role.id,
        title: a.role.title,
        status: a.role.status as RoleStatus,
      });
      rolesByUser.set(a.userId, list);
    }

    return sqlRows.map((r) => ({
      id: r.id,
      name: displayName(r),
      email: r.email,
      status: r.status,
      roles: rolesByUser.get(r.id) ?? [],
      sessions: r.sessions,
      latestScore: r.latest_score,
      band: r.latest_band ? toAdminBand(r.latest_band) : null,
      change: r.change,
      lastActiveAt: r.last_active_at?.toISOString() ?? null,
      lastActiveLabel: r.last_active_at
        ? relativeTime(r.last_active_at, now)
        : 'Not yet',
      ...(r.status === 'invite_pending' &&
        r.invited_at && {
          lastActiveNote: inviteSentLabel(r.invited_at, now),
        }),
    }));
  }
}
