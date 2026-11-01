import { executivePeriod } from './executive-period.js';
import {
  executiveCandidatesQuerySchema,
  executiveQuerySchema,
} from './executive.schemas.js';
import {
  performanceSummary,
  executiveMetadata,
  ExecutiveService,
} from './executive.service.js';
import { executiveCtes, pageSql, type SummaryRow } from './executive.sql.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const now = new Date('2026-11-02T12:00:00Z');
describe('executive reporting definitions', () => {
  it('uses UTC calendar bounds and caps current reports at now', () => {
    const current = executivePeriod(undefined, now);
    expect(current.period).toBe('2026-11');
    expect(current.cohortMonth).toBe('2026-10');
    expect(current.cutoff).toEqual(now);
    const historic = executivePeriod('2026-02', now);
    expect(historic.cohortStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(historic.cutoff.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(executivePeriod('2026-01', now).cohortMonth).toBe('2025-12');
  });
  it.each(['2026-13', '2026-00', '2026-1', '2026-12', '1999-12', 'no'])(
    'rejects invalid/future period %s',
    (period) => {
      expect(() => executivePeriod(period, now)).toThrow();
    },
  );
  it('validates bounded pagination, UUID filters, and literal unknown attribution', () => {
    expect(
      executiveCandidatesQuerySchema.parse({ recruiterId: 'unknown' }),
    ).toEqual({ recruiterId: 'unknown', page: 1, pageSize: 10 });
    for (const query of [
      { page: '0' },
      { pageSize: '101' },
      { page: '1.2' },
      { recruiterId: 'bad' },
      { search: 'x'.repeat(201) },
    ])
      expect(executiveCandidatesQuerySchema.safeParse(query).success).toBe(
        false,
      );
    expect(
      executiveQuerySchema.safeParse({ period: '2026-02', roleId: 'bad' })
        .success,
    ).toBe(false);
  });
  it('keeps unknown/empty improvement null and does not turn no eligible invitations into 0%', () => {
    expect(performanceSummary()).toMatchObject({
      invited: 0,
      paired: 0,
      gain: null,
      first: null,
      latest: null,
      acceptance: { value: null, num: 0, den: 0 },
    });
    const summary = performanceSummary({
      recruiter_id: null,
      invited: 5,
      acceptance_num: 2,
      acceptance_den: 4,
      awaiting: 1,
      assignment_pairs: 7,
      unassigned: 1,
      paired: 3,
      first: 60,
      latest: 65,
      gain: 5,
      improved: 1,
      unchanged: 1,
      declined: 1,
      single_session: 2,
      unassessed: 2,
    } satisfies SummaryRow);
    expect(summary).toMatchObject({
      invited: 5,
      assignmentPairs: 7,
      unassignedCandidates: 1,
      paired: 3,
      gain: 5,
      awaitingAcceptanceWindow: 1,
      acceptance: { value: 0.5 },
    });
    expect(summary.paired + summary.singleSession + summary.unassessed).toBe(
      summary.assignmentPairs,
    );
  });
  it('parameterizes user search and preserves first-invite/erasure/preview/cutoff constraints in one read model', () => {
    const scope = executivePeriod('2026-10', now);
    const cte = executiveCtes(scope);
    expect(cte.sql).toContain('DISTINCT ON (i.user_id)');
    expect(cte.sql.indexOf('first_invites AS')).toBeLessThan(
      cte.sql.indexOf('WHERE i.sent_at >='),
    );
    expect(cte.sql).toContain('u.deleted_at IS NULL');
    expect(cte.sql).toContain('NOT se.is_preview');
    expect(cte.sql).toContain('se.completed_at <');
    const attack = "%' OR true --";
    const query = pageSql(scope, attack, 3, 10);
    expect(query.sql).not.toContain(attack);
    expect(query.values).toContain("%\\%' OR true --%");
    expect(query.values.slice(-2)).toEqual([10, 20]);
  });
  it('reports cutoff, attribution limitations and UTC without personal data', () => {
    const meta = executiveMetadata(executivePeriod('2026-10', now));
    expect(meta.timeZone).toBe('UTC');
    expect(meta.cutoff).toBe('2026-11-01T00:00:00.000Z');
    expect(meta.limitations.some((x) => x.includes('original inviter'))).toBe(
      true,
    );
  });
  it('validates a selected role before returning other reporting data', async () => {
    const tx = { jobRole: { findMany: vi.fn().mockResolvedValue([]) } };
    const prisma = {
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const service = new ExecutiveService(prisma as unknown as PrismaService);
    await expect(
      service.overview({ period: '2026-10', roleId: 'missing' }, now),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });
});
