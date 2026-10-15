import type { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { AppError } from '../../common/errors/app-error.js';
import {
  type EventBus,
  USER_REVOKED_CHANNEL,
} from '../../common/events/event-bus.types.js';
import type { AppConfig } from '../../config/app-config.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { InvitesService } from './invites.service.js';
import { UsersService } from './users.service.js';

const admin = { id: 'adm-1', name: 'Arjun Mehta' } as AuthUser;

function setup() {
  const prisma = {
    user: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    authSession: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    jobRole: { findMany: vi.fn() },
    roleAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const activity = { record: vi.fn() };
  const audit = { record: vi.fn() };
  const invites = { revokePending: vi.fn(), sendEmail: vi.fn() };
  const events = { publish: vi.fn(), subscribe: vi.fn() };
  const config = {
    env: { APP_CANDIDATE_ORIGIN: 'https://app.test' },
  } as AppConfig;
  const service = new UsersService(
    prisma as unknown as PrismaService,
    config,
    activity as unknown as ActivityService,
    audit as unknown as AuditService,
    invites as unknown as InvitesService,
    events as EventBus,
  );
  return { service, prisma, activity, audit, invites, events };
}

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'neha@example.com',
  name: 'Neha Kapoor',
  role: 'candidate',
  status: 'active',
  firstLoginAt: new Date(),
  accessExpiresAt: null,
  ...over,
});

describe('UsersService', () => {
  it('revokeSessions revokes live sessions and publishes the user id', async () => {
    const { service, prisma, events } = setup();
    await expect(service.revokeSessions('u1')).resolves.toBe(2);
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(events.publish).toHaveBeenCalledWith(USER_REVOKED_CHANNEL, {
      userId: 'u1',
    });
  });

  it('findCandidate is a 404 for a non-candidate or missing user', async () => {
    const { service, prisma } = setup();
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.findCandidate('x')).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
      id: 'x',
      role: 'candidate',
    });
  });

  describe('revokeInvite', () => {
    it('revokes a pending invite, its links and audits', async () => {
      const { service, prisma, invites, audit, activity } = setup();
      prisma.user.findFirst.mockResolvedValue(
        candidate({ status: 'invite_pending' }),
      );
      await service.revokeInvite(admin, 'u1', '1.2.3.4');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { status: 'revoked' },
      });
      expect(invites.revokePending).toHaveBeenCalledWith(prisma, 'u1');
      expect(activity.record).toHaveBeenCalledWith('u1', 'Invite revoked');
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'Revoked an invite',
        entityId: 'u1',
        itemLabel: 'Neha Kapoor',
      });
    });

    it('rejects an account that is not pending', async () => {
      const { service, prisma } = setup();
      prisma.user.findFirst.mockResolvedValue(candidate());
      const err = await service
        .revokeInvite(admin, 'u1', null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ status: 400, code: 'validation_failed' });
    });
  });

  it('deactivate turns active off, revokes pending, signs both out and audits once', async () => {
    const { service, prisma, events, audit, invites } = setup();
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', status: 'active' },
      { id: 'u2', status: 'invite_pending' },
    ]);
    await expect(
      service.deactivate(admin, ['u1', 'u2', 'u3'], null),
    ).resolves.toEqual({ deactivated: 2, skipped: 1 });
    expect(prisma.user.update.mock.calls.map((c) => c[0].data.status)).toEqual([
      'deactivated',
      'revoked',
    ]);
    expect(invites.revokePending).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'Deactivated 2 candidates',
      itemLabel: '2 candidates',
    });
  });

  it('deactivate writes no audit when nothing changed', async () => {
    const { service, prisma, audit } = setup();
    prisma.user.findMany.mockResolvedValue([]);
    await expect(service.deactivate(admin, ['u1'], null)).resolves.toEqual({
      deactivated: 0,
      skipped: 1,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reactivate restores active, or invite_pending for a never-logged-in user', async () => {
    const { service, prisma, audit } = setup();
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', firstLoginAt: new Date() },
      { id: 'u2', firstLoginAt: null },
    ]);
    await expect(
      service.reactivate(admin, ['u1', 'u2'], null),
    ).resolves.toEqual({ reactivated: 2 });
    expect(prisma.user.update.mock.calls.map((c) => c[0].data.status)).toEqual([
      'active',
      'invite_pending',
    ]);
    expect(audit.record.mock.calls[0][0].action).toBe(
      'Reactivated 2 candidates',
    );
  });

  describe('assignRoles', () => {
    const role = (over: Record<string, unknown> = {}) => ({
      id: 'r1',
      slug: 'store-manager',
      title: 'Store Manager',
      status: 'approved',
      ...over,
    });

    it('rejects an archived role', async () => {
      const { service, prisma } = setup();
      prisma.jobRole.findMany.mockResolvedValue([role({ status: 'archived' })]);
      prisma.user.findMany.mockResolvedValue([candidate()]);
      await expect(
        service.assignRoles(admin, ['u1'], ['r1'], null),
      ).rejects.toMatchObject({
        status: 400,
        message: 'Store Manager is archived',
      });
    });

    it('is a 404 for an unknown candidate or role', async () => {
      const { service, prisma } = setup();
      prisma.jobRole.findMany.mockResolvedValue([role()]);
      prisma.user.findMany.mockResolvedValue([]);
      await expect(
        service.assignRoles(admin, ['u1'], ['r1'], null),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('skips live assignments, restores removed ones and emails approved roles', async () => {
      const { service, prisma, invites, audit } = setup();
      prisma.jobRole.findMany.mockResolvedValue([
        role(),
        role({ id: 'r2', title: 'Analyst', slug: 'analyst', status: 'draft' }),
      ]);
      prisma.user.findMany.mockResolvedValue([
        candidate(),
        candidate({ id: 'u2', status: 'deactivated' }),
      ]);
      prisma.roleAssignment.findMany.mockResolvedValue([
        { id: 'a1', userId: 'u1', jobRoleId: 'r1', removedAt: null },
        { id: 'a2', userId: 'u2', jobRoleId: 'r1', removedAt: new Date() },
      ]);
      await expect(
        service.assignRoles(admin, ['u1', 'u2'], ['r1', 'r2'], null),
      ).resolves.toEqual({ added: 3 });
      expect(prisma.roleAssignment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'a2' },
          data: expect.objectContaining({ removedAt: null, maxAttempts: null }),
        }),
      );
      expect(prisma.roleAssignment.create).toHaveBeenCalledTimes(2);
      // u2 is deactivated and r2 is a draft: no emails there.
      expect(invites.sendEmail).not.toHaveBeenCalled();
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'Assigned roles',
        itemLabel: '2 candidates',
      });
    });

    it('emails an active candidate a link to an approved role', async () => {
      const { service, prisma, invites } = setup();
      prisma.jobRole.findMany.mockResolvedValue([role()]);
      prisma.user.findMany.mockResolvedValue([candidate()]);
      await service.assignRoles(admin, ['u1'], ['r1'], null);
      expect(invites.sendEmail).toHaveBeenCalledWith('u1', {
        template: 'role-assigned',
        to: 'neha@example.com',
        vars: {
          name: 'Neha Kapoor',
          roleTitle: 'Store Manager',
          link: 'https://app.test/roles/store-manager',
        },
      });
    });
  });

  it('removeRole soft-removes a live assignment and audits', async () => {
    const { service, prisma, audit } = setup();
    prisma.user.findFirst.mockResolvedValue(candidate());
    prisma.roleAssignment.findFirst.mockResolvedValue({
      id: 'a1',
      maxAttempts: null,
      role: { title: 'Store Manager' },
    });
    await service.removeRole(admin, 'u1', 'r1', null);
    expect(prisma.roleAssignment.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { removedAt: expect.any(Date) },
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'Removed a role',
      itemLabel: 'Neha Kapoor · Store Manager',
    });
  });

  it('removeRole is a 404 without a live assignment', async () => {
    const { service, prisma } = setup();
    prisma.user.findFirst.mockResolvedValue(candidate());
    prisma.roleAssignment.findFirst.mockResolvedValue(null);
    await expect(
      service.removeRole(admin, 'u1', 'r1', null),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('updateAssignment sets the limit and audits old → new', async () => {
    const { service, prisma, audit } = setup();
    prisma.user.findFirst.mockResolvedValue(candidate());
    prisma.roleAssignment.findFirst.mockResolvedValue({
      id: 'a1',
      maxAttempts: null,
      role: { title: 'Store Manager' },
    });
    await service.updateAssignment(admin, 'u1', 'r1', 3, null);
    expect(prisma.roleAssignment.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { maxAttempts: 3 },
    });
    expect(audit.record.mock.calls[0][0].itemLabel).toBe(
      'Neha Kapoor · Store Manager: Role default → 3',
    );
  });

  it('updateCandidate changes only the given fields', async () => {
    const { service, prisma, audit } = setup();
    prisma.user.findFirst.mockResolvedValue(candidate());
    const until = new Date('2026-12-31T23:59:59.999Z');
    await service.updateCandidate(admin, 'u1', { accessUntil: until }, null);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { accessExpiresAt: until },
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'Edited candidate',
      before: { accessUntil: null },
      after: { accessUntil: until.toISOString() },
    });
  });
});
