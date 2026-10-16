import type { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { AdminsService } from './admins.service.js';
import type { InvitesService } from './invites.service.js';
import type { UsersService } from './users.service.js';

const actor = { id: 'me', role: 'super_admin' } as AuthUser;

const adminRow = (over: Record<string, unknown> = {}) => ({
  id: 'a2',
  email: 'kavya@company.com',
  name: 'Kavya Menon',
  title: null,
  role: 'super_admin',
  status: 'active',
  lastActiveAt: null,
  invites: [],
  ...over,
});

function setup() {
  const prisma = {
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    unfiltered: { user: { findUnique: vi.fn() } },
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const invites = {
    issueInvite: vi.fn().mockResolvedValue({ token: 'tok', expiresDays: 7 }),
    reissue: vi.fn().mockResolvedValue({ token: 'tok2', expiresDays: 7 }),
    revokePending: vi.fn(),
    sendEmail: vi.fn(),
    adminLink: vi.fn(
      (email: string, token: string) => `https://admin.test/${email}/${token}`,
    ),
  };
  const users = { revokeSessions: vi.fn() };
  const audit = { record: vi.fn() };
  const settings = {
    get: vi.fn().mockResolvedValue({ inviteLinkExpiryDays: 7 }),
  };
  const service = new AdminsService(
    prisma as unknown as PrismaService,
    settings as unknown as SettingsService,
    invites as unknown as InvitesService,
    users as unknown as UsersService,
    audit as unknown as AuditService,
  );
  return { service, prisma, invites, users, audit };
}

describe('AdminsService', () => {
  it('list maps users to the admin UI shape', async () => {
    const { service, prisma } = setup();
    const sentAt = new Date('2026-10-01T10:00:00Z');
    prisma.user.findMany.mockResolvedValue([
      adminRow({ status: 'invite_pending', name: null, invites: [{ sentAt }] }),
    ]);
    await expect(service.list()).resolves.toEqual([
      {
        id: 'a2',
        name: null,
        email: 'kavya@company.com',
        access: 'super_admin',
        status: 'invite_pending',
        lastActiveAt: null,
        invitedAt: sentAt.toISOString(),
      },
    ]);
  });

  describe('invite', () => {
    it.each([
      ['an active candidate', { role: 'candidate', status: 'active' }],
      ['a deactivated candidate', { role: 'candidate', status: 'deactivated' }],
      ['a revoked candidate', { role: 'candidate', status: 'revoked' }],
      ['an active admin', { role: 'admin', status: 'active' }],
      ['a pending admin', { role: 'super_admin', status: 'invite_pending' }],
      [
        'an erased removed admin',
        { role: 'admin', status: 'revoked', deletedAt: new Date() },
      ],
    ])('is a 409 when the email belongs to %s', async (_, user) => {
      const { service, prisma, invites, audit } = setup();
      prisma.unfiltered.user.findUnique.mockResolvedValue({
        id: 'x',
        email: 'a@b.co',
        deletedAt: null,
        ...user,
      });
      await expect(
        service.invite(actor, { email: 'a@b.co', access: 'admin' }, null),
      ).rejects.toMatchObject({
        status: 409,
        code: 'conflict',
        message: 'Already an admin or invited',
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(invites.issueInvite).not.toHaveBeenCalled();
      expect(invites.reissue).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('re-invites a removed admin on their existing row, audits and emails', async () => {
      const { service, prisma, invites, users, audit } = setup();
      prisma.unfiltered.user.findUnique.mockResolvedValue({
        id: 'a2',
        email: 'kavya@company.com',
        role: 'super_admin',
        status: 'revoked',
        deletedAt: null,
      });
      prisma.user.findFirst.mockResolvedValue(
        adminRow({ role: 'admin', status: 'invite_pending' }),
      );
      const res = await service.invite(
        actor,
        { email: 'kavya@company.com', access: 'admin' },
        '1.1.1.1',
      );
      expect(res).toMatchObject({
        id: 'a2',
        access: 'admin',
        status: 'invite_pending',
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'a2',
          deletedAt: null,
          role: { in: ['admin', 'super_admin'] },
          status: { in: ['revoked', 'deactivated'] },
        },
        data: { role: 'admin', status: 'invite_pending' },
      });
      expect(invites.reissue).toHaveBeenCalledWith(
        prisma,
        { userId: 'a2', email: 'kavya@company.com', invitedBy: 'me' },
        7,
      );
      expect(invites.issueInvite).not.toHaveBeenCalled();
      expect(users.revokeSessions).toHaveBeenCalledWith('a2');
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'me',
        action: 'Invited an admin',
        entity: 'user',
        entityId: 'a2',
        itemLabel: 'kavya@company.com',
        after: { access: 'admin' },
        ip: '1.1.1.1',
      });
      expect(invites.sendEmail).toHaveBeenCalledWith('a2', {
        template: 'admin-invite',
        to: 'kavya@company.com',
        vars: {
          link: 'https://admin.test/kavya@company.com/tok2',
          access: 'admin',
          expiresDays: 7,
        },
      });
    });

    it('is a 409 when a concurrent invite already reactivated the admin', async () => {
      const { service, prisma, invites, audit } = setup();
      prisma.unfiltered.user.findUnique.mockResolvedValue({
        id: 'a2',
        email: 'kavya@company.com',
        role: 'admin',
        status: 'deactivated',
        deletedAt: null,
      });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.invite(
          actor,
          { email: 'kavya@company.com', access: 'admin' },
          null,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(invites.reissue).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('creates a pending admin with an invite, audits and emails', async () => {
      const { service, prisma, invites, audit } = setup();
      prisma.unfiltered.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'n1', email: 'a@b.co' });
      prisma.user.findFirst.mockResolvedValue(
        adminRow({
          id: 'n1',
          email: 'a@b.co',
          name: null,
          role: 'admin',
          status: 'invite_pending',
        }),
      );
      const res = await service.invite(
        actor,
        { email: 'a@b.co', access: 'admin' },
        null,
      );
      expect(res).toMatchObject({ id: 'n1', status: 'invite_pending' });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: 'a@b.co', role: 'admin', status: 'invite_pending' },
      });
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'Invited an admin',
        itemLabel: 'a@b.co',
      });
      expect(invites.sendEmail).toHaveBeenCalledWith('n1', {
        template: 'admin-invite',
        to: 'a@b.co',
        vars: {
          link: 'https://admin.test/a@b.co/tok',
          access: 'admin',
          expiresDays: 7,
        },
      });
    });
  });

  it('resend only works on a pending invite', async () => {
    const { service, prisma } = setup();
    prisma.user.findFirst.mockResolvedValue(adminRow());
    await expect(service.resend(actor, 'a2', null)).rejects.toMatchObject({
      status: 400,
    });
  });

  describe('changeAccess', () => {
    it('refuses to change the caller', async () => {
      const { service } = setup();
      await expect(
        service.changeAccess(actor, 'me', 'admin', null),
      ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    });

    it('keeps at least one active Super admin', async () => {
      const { service, prisma } = setup();
      prisma.user.findFirst.mockResolvedValue(adminRow());
      prisma.user.count.mockResolvedValue(0);
      await expect(
        service.changeAccess(actor, 'a2', 'admin', null),
      ).rejects.toMatchObject({
        status: 400,
        message: 'There must be at least one Super admin',
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('demotes when another Super admin remains and audits', async () => {
      const { service, prisma, audit } = setup();
      prisma.user.findFirst.mockResolvedValue(adminRow());
      prisma.user.count.mockResolvedValue(1);
      await service.changeAccess(actor, 'a2', 'admin', null);
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'a2' },
        data: { role: 'admin' },
      });
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'Changed admin access',
        itemLabel: 'Kavya Menon: Super admin → Admin',
      });
    });

    it('is a 404 for a non-admin target', async () => {
      const { service, prisma } = setup();
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.changeAccess(actor, 'c1', 'admin', null),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('remove', () => {
    it('refuses self-removal', async () => {
      const { service } = setup();
      await expect(service.remove(actor, 'me', null)).rejects.toMatchObject({
        status: 400,
        message: 'You can’t remove yourself',
      });
    });

    it('revokes the admin, their invites and sessions', async () => {
      const { service, prisma, invites, users, audit } = setup();
      prisma.user.findFirst.mockResolvedValue(adminRow({ role: 'admin' }));
      await service.remove(actor, 'a2', null);
      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'a2' },
        data: { status: 'revoked' },
      });
      expect(invites.revokePending).toHaveBeenCalledWith(prisma, 'a2');
      expect(users.revokeSessions).toHaveBeenCalledWith('a2');
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'Removed an admin',
        itemLabel: 'Kavya Menon',
      });
    });
  });
});
