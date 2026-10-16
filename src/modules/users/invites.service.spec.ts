import { Logger } from '@nestjs/common';
import type { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { sha256Hex } from '../../common/crypto.js';
import type { AppConfig } from '../../config/app-config.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { EmailService } from '../../jobs/email/email.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { InvitesService } from './invites.service.js';

const admin = { id: 'adm-1', name: 'Arjun Mehta' } as AuthUser;
const R1 = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const R2 = '7f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

function setup() {
  let n = 0;
  const prisma = {
    jobRole: { findMany: vi.fn() },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(({ data }) => ({ id: `u${++n}`, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    invite: { create: vi.fn(), updateMany: vi.fn() },
    inviteBatch: {
      create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
      update: vi.fn(),
    },
    roleAssignment: {
      createMany: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
    unfiltered: { user: { findMany: vi.fn().mockResolvedValue([]) } },
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const email = { send: vi.fn() };
  const activity = { record: vi.fn() };
  const audit = { record: vi.fn() };
  const settings = {
    get: vi.fn().mockResolvedValue({ inviteLinkExpiryDays: 7 }),
  };
  const config = {
    env: { APP_CANDIDATE_ORIGIN: 'https://app.test' },
  } as AppConfig;
  const service = new InvitesService(
    prisma as unknown as PrismaService,
    config,
    settings as unknown as SettingsService,
    email as unknown as EmailService,
    activity as unknown as ActivityService,
    audit as unknown as AuditService,
  );
  return { service, prisma, email, activity, audit };
}

const owner = (over: Record<string, unknown> = {}) => ({
  id: 'u-old',
  email: 'old@example.com',
  role: 'candidate',
  status: 'active',
  deletedAt: null,
  ...over,
});

describe('InvitesService', () => {
  it('validate checks rows against approved and draft roles and existing users', async () => {
    const { service, prisma } = setup();
    prisma.jobRole.findMany.mockResolvedValue([
      { title: 'Store Manager', status: 'approved' },
      { title: 'Analyst', status: 'draft' },
    ]);
    prisma.unfiltered.user.findMany.mockResolvedValue([
      owner({ email: 'taken@example.com' }),
    ]);
    const res = await service.validate([
      { email: 'new@example.com', name: 'New', roles: ['store manager'] },
      { email: 'taken@example.com', name: 'T', roles: ['Store Manager'] },
      { email: 'x@example.com', name: 'X', roles: ['Analyst'] },
    ]);
    expect(res.rows.map((r) => r.result)).toEqual([
      'ready',
      'already_invited',
      'role_not_approved',
    ]);
    expect(res.summary).toEqual({ total: 3, ready: 1, needFixing: 2 });
  });

  it('invite creates user, invite, assignments and batch, then audits and emails', async () => {
    const { service, prisma, email, audit, activity } = setup();
    prisma.jobRole.findMany.mockResolvedValue([
      { id: R1, title: 'Store Manager' },
    ]);
    prisma.unfiltered.user.findMany.mockResolvedValue([
      owner({ email: 'taken@example.com' }),
    ]);
    const until = new Date('2026-12-31T23:59:59.999Z');
    const res = await service.invite(
      admin,
      {
        source: 'csv',
        fileName: 'march.csv',
        accessUntil: until,
        maxSessions: 3,
        rows: [
          { email: ' Neha@Example.com ', name: 'Neha', roleIds: [R1] },
          { email: 'taken@example.com', name: 'T', roleIds: [R1] },
          { email: 'neha@example.com', name: 'Dup', roleIds: [R1] },
          { email: 'other@example.com', name: 'O', roleIds: [R2] },
          { email: 'none@example.com', name: 'N', roleIds: [] },
          { email: 'bad', name: 'B', roleIds: [R1] },
        ],
      },
      '1.2.3.4',
    );
    expect(res).toEqual({
      batchId: 'batch-1',
      sent: 1,
      skipped: 5,
      candidateIds: ['u1'],
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: 'neha@example.com',
        name: 'Neha',
        role: 'candidate',
        status: 'invite_pending',
        accessExpiresAt: until,
      },
    });
    const invite = prisma.invite.create.mock.calls[0][0].data;
    expect(invite).toMatchObject({
      userId: 'u1',
      invitedBy: 'adm-1',
      batchId: 'batch-1',
    });
    expect(invite.expiresAt.getTime() - invite.sentAt.getTime()).toBe(
      7 * 864e5,
    );
    expect(prisma.roleAssignment.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u1', jobRoleId: R1, assignedBy: 'adm-1', maxAttempts: 3 },
      ],
    });
    expect(prisma.inviteBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { sent: 1, skipped: 5 },
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'Sent invites',
      entity: 'invite_batch',
      entityId: 'batch-1',
      itemLabel: '1 invite · march.csv',
    });
    expect(activity.record).toHaveBeenCalledWith(
      'u1',
      'Invited by Arjun Mehta',
    );

    const job = email.send.mock.calls[0][0];
    expect(job).toMatchObject({
      template: 'candidate-invite',
      to: 'neha@example.com',
      vars: { name: 'Neha', expiresDays: 7, roleTitles: ['Store Manager'] },
    });
    const link = new URL(job.vars.link);
    expect(link.origin + link.pathname).toBe('https://app.test/login/code');
    expect(link.searchParams.get('email')).toBe('neha@example.com');
    expect(sha256Hex(link.searchParams.get('token')!)).toBe(invite.tokenHash);
  });

  it('validate treats a revoked candidate as invitable and a hidden user as taken; context hides hidden users', async () => {
    const { service, prisma } = setup();
    prisma.jobRole.findMany.mockResolvedValue([
      { title: 'Store Manager', status: 'approved' },
    ]);
    const owners = [
      owner({ email: 'revoked@example.com', status: 'revoked' }),
      owner({
        email: 'erased@example.com',
        status: 'active',
        deletedAt: new Date(),
      }),
      owner({
        email: 'erased-revoked@example.com',
        status: 'revoked',
        deletedAt: new Date(),
      }),
      owner({ email: 'admin@example.com', role: 'admin', status: 'revoked' }),
      owner({ email: 'off@example.com', status: 'deactivated' }),
    ];
    prisma.unfiltered.user.findMany.mockResolvedValue(owners);
    const res = await service.validate(
      owners.map((o) => ({
        email: o.email,
        name: '',
        roles: ['Store Manager'],
      })),
    );
    expect(res.rows.map((r) => r.result)).toEqual([
      'ready',
      'already_invited',
      'already_invited',
      'already_invited',
      'already_invited',
    ]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();

    const ctx = await service.getContext();
    expect(ctx.existingEmails).toEqual([
      'admin@example.com',
      'off@example.com',
    ]);
  });

  it('invite reuses a revoked candidate: pending again, fresh token, counted and emailed', async () => {
    const { service, prisma, email, audit, activity } = setup();
    prisma.jobRole.findMany.mockResolvedValue([
      { id: R1, title: 'Store Manager' },
    ]);
    prisma.unfiltered.user.findMany.mockResolvedValue([
      owner({ id: 'u-rev', email: 'rev@example.com', status: 'revoked' }),
      owner({
        id: 'u-gone',
        email: 'gone@example.com',
        status: 'revoked',
        deletedAt: new Date(),
      }),
    ]);
    const until = new Date('2026-12-31T23:59:59.999Z');
    const res = await service.invite(
      admin,
      {
        source: 'csv',
        accessUntil: until,
        maxSessions: 2,
        rows: [
          { email: 'Rev@Example.com', name: 'Neha', roleIds: [R1] },
          { email: 'gone@example.com', name: 'G', roleIds: [R1] },
        ],
      },
      null,
    );
    expect(res).toEqual({
      batchId: 'batch-1',
      sent: 1,
      skipped: 1,
      candidateIds: ['u-rev'],
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'u-rev',
        role: 'candidate',
        status: 'revoked',
        deletedAt: null,
      },
      data: { name: 'Neha', status: 'invite_pending', accessExpiresAt: until },
    });
    expect(prisma.roleAssignment.updateMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 'u-rev', removedAt: null, jobRoleId: { notIn: [R1] } },
    });
    const upsert = prisma.roleAssignment.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({
      userId_jobRoleId: { userId: 'u-rev', jobRoleId: R1 },
    });
    expect(upsert.update).toMatchObject({
      removedAt: null,
      assignedBy: 'adm-1',
      maxAttempts: 2,
    });
    expect(upsert.create).toMatchObject({
      userId: 'u-rev',
      jobRoleId: R1,
      assignedBy: 'adm-1',
      maxAttempts: 2,
    });
    expect(prisma.invite.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u-rev', status: 'pending' },
      data: { status: 'expired' },
    });
    const invite = prisma.invite.create.mock.calls[0][0].data;
    expect(invite).toMatchObject({
      userId: 'u-rev',
      email: 'rev@example.com',
      batchId: 'batch-1',
    });
    expect(prisma.inviteBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { sent: 1, skipped: 1 },
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'Sent invites',
      after: { candidateIds: ['u-rev'] },
    });
    expect(activity.record).toHaveBeenCalledWith(
      'u-rev',
      'Invited by Arjun Mehta',
    );
    const job = email.send.mock.calls[0][0];
    expect(job).toMatchObject({
      template: 'candidate-invite',
      to: 'rev@example.com',
      vars: { name: 'Neha', roleTitles: ['Store Manager'] },
    });
    const token = new URL(job.vars.link).searchParams.get('token')!;
    expect(sha256Hex(token)).toBe(invite.tokenHash);
  });

  it('invite skips a revoked candidate that changed concurrently', async () => {
    const { service, prisma, email } = setup();
    prisma.jobRole.findMany.mockResolvedValue([{ id: R1, title: 'S' }]);
    prisma.unfiltered.user.findMany.mockResolvedValue([
      owner({ id: 'u-rev', email: 'rev@example.com', status: 'revoked' }),
    ]);
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    const res = await service.invite(
      admin,
      {
        source: 'single',
        rows: [{ email: 'rev@example.com', name: '', roleIds: [R1] }],
      },
      null,
    );
    expect(res).toMatchObject({ sent: 0, skipped: 1, candidateIds: [] });
    expect(prisma.invite.create).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('invite skips a row whose email was taken concurrently (P2002)', async () => {
    const { service, prisma, audit } = setup();
    prisma.jobRole.findMany.mockResolvedValue([{ id: R1, title: 'S' }]);
    prisma.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    const res = await service.invite(
      admin,
      {
        source: 'single',
        rows: [{ email: 'a@example.com', name: '', roleIds: [R1] }],
      },
      null,
    );
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'Sent invites',
      itemLabel: '0 invites · a@example.com',
    });
  });

  it('resend expires old links and mails a fresh one to pending candidates only', async () => {
    const { service, prisma, email, audit } = setup();
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        email: 'neha@example.com',
        name: null,
        assignments: [{ role: { title: 'Store Manager' } }],
      },
    ]);
    await expect(service.resend(admin, ['u1', 'u2'], null)).resolves.toEqual({
      resent: 1,
      skipped: 1,
    });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['u1', 'u2'] },
      role: 'candidate',
      status: 'invite_pending',
    });
    expect(prisma.invite.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', status: 'pending' },
      data: { status: 'expired' },
    });
    expect(prisma.invite.create).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].vars).toMatchObject({
      name: '',
      roleTitles: ['Store Manager'],
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'Resent invites',
      itemLabel: '1 candidate',
    });
  });

  it('an email queue failure does not fail the action', async () => {
    const { service, email } = setup();
    email.send.mockRejectedValue(new Error('queue down'));
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await expect(
      service.sendEmail('u1', {
        template: 'login-code',
        to: 'a@example.com',
        vars: { code: '123456', minutes: 10 },
      }),
    ).resolves.toBeUndefined();
    expect(logged.mock.calls[0][0]).toEqual({
      userId: 'u1',
      template: 'login-code',
      err: expect.any(Error),
    });
    logged.mockRestore();
  });
});
