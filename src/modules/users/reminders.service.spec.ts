import type { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import type { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import type { AppConfig } from '../../config/app-config.js';
import type { EmailService } from '../../jobs/email/email.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AssignmentsService } from './assignments.service.js';
import { remindCandidatesSchema } from './reminders.controller.js';
import { RemindersService } from './reminders.service.js';

const U1 = '30b97b8e-6c34-4b3e-bedd-230dc799727c';
const U2 = 'b79d7446-e0ef-4c59-9fd5-93f84bf4ef42';
const R1 = 'd6196b14-a535-49aa-bfc0-5aeb09409dd4';
const admin = { id: 'admin-1' } as AuthUser;

function setup() {
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue({
        id: U1,
        name: 'Priya',
        email: 'priya@example.com',
      }),
    },
  };
  const assignments = {
    listCandidateRoles: vi
      .fn()
      .mockResolvedValue([
        { assignment: { maxAttempts: 3 }, role: { id: R1, settings: {} } },
      ]),
    getStatsForUser: vi
      .fn()
      .mockResolvedValue([{ jobRoleId: R1, sessionsUsed: 1 }]),
    attemptsLeft: AssignmentsService.prototype.attemptsLeft,
  };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const rateLimiter = {
    consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSec: 0 }),
    reset: vi.fn(),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const config = {
    env: { APP_CANDIDATE_ORIGIN: 'https://app.example.com' },
  } as AppConfig;
  const service = new RemindersService(
    prisma as unknown as PrismaService,
    assignments as unknown as AssignmentsService,
    email as unknown as EmailService,
    rateLimiter as unknown as RateLimiter,
    audit as unknown as AuditService,
    config,
  );
  return { service, prisma, assignments, email, rateLimiter, audit };
}

describe('remindCandidatesSchema', () => {
  it('defaults to preview and deduplicates UUIDs', () => {
    expect(remindCandidatesSchema.parse({ candidateIds: [U1, U1] })).toEqual({
      candidateIds: [U1],
      dryRun: true,
    });
  });

  it('rejects malformed IDs, empty or oversized recipient lists and arbitrary email copy', () => {
    for (const input of [
      { candidateIds: [] },
      { candidateIds: ['invalid'] },
      { candidateIds: Array.from({ length: 101 }, () => U1) },
      { candidateIds: [U1], message: 'arbitrary copy' },
    ]) {
      expect(remindCandidatesSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('RemindersService', () => {
  afterEach(() => vi.useRealTimers());

  it('previews deduplicated recipients without mail, cooldown or audit mutations', async () => {
    const { service, prisma, email, rateLimiter, audit } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const result = await service.remind(
      admin,
      { candidateIds: [U1, U1] },
      null,
    );
    expect(result).toEqual({
      dryRun: true,
      eligible: 1,
      queued: 0,
      skipped: 0,
      rows: [{ candidateId: U1, status: 'eligible' }],
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: U1,
        role: 'candidate',
        status: 'active',
        deletedAt: null,
        OR: [
          { accessExpiresAt: null },
          { accessExpiresAt: { gt: new Date('2026-11-02T12:00:00Z') } },
        ],
      },
      select: { id: true, name: true, email: true },
    });
    expect(email.send).not.toHaveBeenCalled();
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips unknown/inactive/expired/erased users before reading assignments', async () => {
    const { service, prisma, assignments, rateLimiter } = setup();
    prisma.user.findFirst.mockResolvedValue(null);
    expect(
      await service.remind(admin, { candidateIds: [U1], dryRun: false }, null),
    ).toMatchObject({
      eligible: 0,
      queued: 0,
      skipped: 1,
      rows: [{ candidateId: U1, status: 'ineligible' }],
    });
    expect(assignments.listCandidateRoles).not.toHaveBeenCalled();
    expect(rateLimiter.consume).not.toHaveBeenCalled();
  });

  it('requires a current approved assignment with capacity', async () => {
    const { service, assignments } = setup();
    assignments.listCandidateRoles.mockResolvedValueOnce([]);
    expect(
      await service.remind(admin, { candidateIds: [U1] }, null),
    ).toMatchObject({
      eligible: 0,
      rows: [{ candidateId: U1, status: 'ineligible' }],
    });
    assignments.getStatsForUser.mockResolvedValue([
      { jobRoleId: R1, sessionsUsed: 3 },
    ]);
    expect(
      await service.remind(admin, { candidateIds: [U1] }, null),
    ).toMatchObject({
      eligible: 0,
    });
    assignments.listCandidateRoles.mockResolvedValue([
      {
        assignment: { maxAttempts: null },
        role: { id: R1, settings: { maxSessionsPerCandidate: 2 } },
      },
    ] as never);
    expect(
      await service.remind(admin, { candidateIds: [U1] }, null),
    ).toMatchObject({
      eligible: 0,
    });
    assignments.listCandidateRoles.mockResolvedValue([
      { assignment: { maxAttempts: null }, role: { id: R1, settings: {} } },
    ] as never);
    expect(
      await service.remind(admin, { candidateIds: [U1] }, null),
    ).toMatchObject({
      eligible: 1,
    });
  });

  it('queues a fixed template using an ordinary login link and audits IDs only', async () => {
    const { service, email, audit, rateLimiter, prisma } = setup();
    const result = await service.remind(
      admin,
      { candidateIds: [U1], dryRun: false },
      '127.0.0.1',
    );
    expect(result).toEqual({
      dryRun: false,
      eligible: 1,
      queued: 1,
      skipped: 0,
      rows: [{ candidateId: U1, status: 'queued' }],
    });
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
    expect(rateLimiter.consume).toHaveBeenCalledWith(
      `practice-reminder:${U1}`,
      1,
      86400,
    );
    expect(email.send).toHaveBeenCalledWith({
      template: 'practice-reminder',
      to: 'priya@example.com',
      vars: { name: 'Priya', link: 'https://app.example.com/login' },
    });
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'Sent practice reminders',
      entity: 'user',
      entityId: U1,
      itemLabel: '1 practice reminder queued',
      after: { candidateIds: [U1], queued: 1 },
      ip: '127.0.0.1',
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'priya@example.com',
    );
    expect(JSON.stringify(result)).not.toContain('priya@example.com');
  });

  it('honors a candidate-wide cooldown without sending or auditing', async () => {
    const { service, email, rateLimiter, audit } = setup();
    rateLimiter.consume.mockResolvedValue({
      allowed: false,
      retryAfterSec: 23,
    });
    const result = await service.remind(
      admin,
      { candidateIds: [U1], dryRun: false },
      null,
    );
    expect(result).toMatchObject({
      eligible: 1,
      queued: 0,
      skipped: 1,
      rows: [{ candidateId: U1, status: 'cooldown' }],
    });
    expect(email.send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rechecks eligibility after claiming cooldown, before sending', async () => {
    const { service, prisma, email } = setup();
    prisma.user.findFirst.mockResolvedValueOnce({
      id: U1,
      name: 'P',
      email: 'p@example.com',
    });
    prisma.user.findFirst.mockResolvedValueOnce(null);
    const result = await service.remind(
      admin,
      { candidateIds: [U1], dryRun: false },
      null,
    );
    expect(result.rows).toEqual([{ candidateId: U1, status: 'ineligible' }]);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('reports partial queue failure and retains the cooldown to prevent ambiguous retries', async () => {
    const { service, email, audit, rateLimiter } = setup();
    email.send.mockRejectedValueOnce(new Error('queue timeout'));
    const result = await service.remind(
      admin,
      { candidateIds: [U1, U2], dryRun: false },
      null,
    );
    expect(result).toEqual({
      dryRun: false,
      eligible: 2,
      queued: 1,
      skipped: 1,
      rows: [
        { candidateId: U1, status: 'queue_failed' },
        { candidateId: U2, status: 'queued' },
      ],
    });
    expect(rateLimiter.reset).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0].after).toEqual({
      candidateIds: [U2],
      queued: 1,
    });
  });
});
