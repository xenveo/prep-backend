import { AppError } from '../../common/errors/app-error.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AssignmentsService } from './assignments.service.js';

const ROLE_ID = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const role = {
  id: ROLE_ID,
  slug: 'store-manager',
  title: 'Store Manager',
  status: 'approved',
  settings: { maxSessionsPerCandidate: 5 },
};
const assignment = {
  id: 'as-1',
  userId: 'u1',
  jobRoleId: ROLE_ID,
  maxAttempts: null,
  removedAt: null,
};

function mockPrisma() {
  return {
    roleAssignment: { findFirst: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  };
}

describe('AssignmentsService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: AssignmentsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new AssignmentsService(prisma as unknown as PrismaService);
  });

  describe('findCandidateRole', () => {
    it('looks up by slug and only matches live assignments to approved roles', async () => {
      prisma.roleAssignment.findFirst.mockResolvedValue({
        ...assignment,
        role,
      });
      const found = await service.findCandidateRole('u1', 'store-manager');
      expect(found).toEqual({ assignment, role });
      expect(prisma.roleAssignment.findFirst.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        removedAt: null,
        user: { deletedAt: null },
        role: { slug: 'store-manager', status: 'approved' },
      });
    });

    it('looks up by uuid', async () => {
      prisma.roleAssignment.findFirst.mockResolvedValue({
        ...assignment,
        role,
      });
      await service.findCandidateRole('u1', ROLE_ID.toUpperCase());
      expect(
        prisma.roleAssignment.findFirst.mock.calls[0][0].where.role,
      ).toEqual({
        id: ROLE_ID.toUpperCase(),
        status: 'approved',
      });
    });

    it('is a 404 when unassigned, removed, draft or archived (no row matches)', async () => {
      prisma.roleAssignment.findFirst.mockResolvedValue(null);
      const err = await service
        .findCandidateRole('u1', 'store-manager')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        status: 404,
        code: 'not_found',
        message: 'Role not found',
      });
    });
  });

  it('listCandidateRoles orders by title and splits rows', async () => {
    prisma.roleAssignment.findMany.mockResolvedValue([{ ...assignment, role }]);
    await expect(service.listCandidateRoles('u1')).resolves.toEqual([
      { assignment, role },
    ]);
    const args = prisma.roleAssignment.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: 'u1',
      removedAt: null,
      user: { deletedAt: null },
      role: { status: 'approved' },
    });
    expect(args.orderBy).toEqual({ role: { title: 'asc' } });
  });

  it('maps view rows to numbers', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        assignment_id: 'as-1',
        user_id: 'u1',
        job_role_id: ROLE_ID,
        sessions_used: 3n,
        sessions_completed: 2n,
        baseline_score: 48,
        latest_score: 71,
        latest_band: 'nearly_ready',
        best_score: 71,
        best_band: 'nearly_ready',
        change: 23,
        last_completed_at: null,
      },
    ]);
    await expect(service.getStats('u1', ROLE_ID)).resolves.toEqual({
      assignmentId: 'as-1',
      userId: 'u1',
      jobRoleId: ROLE_ID,
      sessionsUsed: 3,
      sessionsCompleted: 2,
      baselineScore: 48,
      latestScore: 71,
      latestBand: 'nearly_ready',
      bestScore: 71,
      bestBand: 'nearly_ready',
      change: 23,
      lastCompletedAt: null,
    });
    const [, ...params] = prisma.$queryRaw.mock.calls[0];
    expect(params).toEqual(['u1', ROLE_ID]);
  });

  it('getStats is null when there is no assignment row', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.getStats('u1', ROLE_ID)).resolves.toBeNull();
  });

  describe('attemptsLeft', () => {
    it('uses the assignment limit over the role default', () => {
      expect(
        service.attemptsLeft({ maxAttempts: 2 }, role, { sessionsUsed: 1 }),
      ).toBe(1);
      expect(
        service.attemptsLeft({ maxAttempts: null }, role, { sessionsUsed: 1 }),
      ).toBe(4);
    });

    it('never goes below zero and treats missing stats as none used', () => {
      expect(
        service.attemptsLeft({ maxAttempts: 2 }, role, { sessionsUsed: 5 }),
      ).toBe(0);
      expect(service.attemptsLeft({ maxAttempts: null }, role, null)).toBe(5);
    });

    it('is null (unlimited) when neither sets a limit', () => {
      expect(
        service.attemptsLeft(
          { maxAttempts: null },
          { settings: { maxSessionsPerCandidate: null } },
          null,
        ),
      ).toBeNull();
    });
  });
});
