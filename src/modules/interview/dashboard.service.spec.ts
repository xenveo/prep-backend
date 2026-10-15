import type { AuthUser } from '../../common/auth/auth.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ContentQueryService } from '../content/content-query.service.js';
import type { AssignmentsService } from '../users/assignments.service.js';
import { DashboardService, deriveStatus } from './dashboard.service.js';

describe('deriveStatus', () => {
  const stats = (
    completed: number,
    best: number | null,
    base: number | null,
  ) => ({
    sessionsCompleted: completed,
    bestScore: best,
    baselineScore: base,
  });

  it('interviewing wins over everything', () => {
    expect(deriveStatus(3, stats(2, 80, 50), 12)).toEqual({
      kind: 'interviewing',
      question: 3,
    });
  });

  it('completed: best score, baseline only with two or more sessions', () => {
    expect(deriveStatus(null, stats(1, 60, 60), 12)).toEqual({
      kind: 'completed',
      score: 60,
      baseline: null,
    });
    expect(deriveStatus(null, stats(2, 80, 54), 12)).toEqual({
      kind: 'completed',
      score: 80,
      baseline: 54,
    });
  });

  it('studying, then not-started', () => {
    expect(deriveStatus(null, stats(0, null, null), 4)).toEqual({
      kind: 'studying',
      viewed: 4,
    });
    expect(deriveStatus(null, null, 0)).toEqual({ kind: 'not-started' });
  });
});

describe('DashboardService.listRoles', () => {
  it('maps roles, stats and bands to RoleWithStatus', async () => {
    const role = {
      id: 'r1',
      slug: 'store-manager',
      title: 'Store Manager',
      blurb: 'Run a store',
      settings: { questionsPerSession: 5 },
    };
    const assignments = {
      listCandidateRoles: vi
        .fn()
        .mockResolvedValue([{ assignment: { maxAttempts: 5 }, role }]),
      getStatsForUser: vi.fn().mockResolvedValue([
        {
          jobRoleId: 'r1',
          sessionsUsed: 2,
          sessionsCompleted: 2,
          baselineScore: 54,
          latestScore: 66,
          latestBand: 'developing',
          bestScore: 66,
          bestBand: 'developing',
        },
      ]),
      attemptsLeft: vi.fn().mockReturnValue(3),
    };
    const prisma = { session: { findMany: vi.fn().mockResolvedValue([]) } };
    const content = {
      approvedCardCount: vi.fn().mockResolvedValue(12),
      viewedApprovedCardCount: vi.fn().mockResolvedValue(12),
    };
    const service = new DashboardService(
      prisma as unknown as PrismaService,
      assignments as unknown as AssignmentsService,
      content as unknown as ContentQueryService,
    );
    const expires = new Date('2026-12-01T00:00:00Z');
    const [row] = await service.listRoles({
      id: 'u1',
      accessExpiresAt: expires,
    } as AuthUser);
    expect(row).toEqual({
      id: 'store-manager',
      name: 'Store Manager',
      blurb: 'Run a store',
      cardCount: 12,
      questionCount: 5,
      status: { kind: 'completed', score: 66, baseline: 54 },
      latest: 66,
      bestBand: 'developing',
      latestBand: 'developing',
      attemptsLeft: 3,
      accessExpiresAt: expires.toISOString(),
    });
  });
});
