import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  conflict,
  notFound,
  validationFailed,
} from '../../common/errors/app-error.js';
import type { Prisma, User } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { InvitesService } from './invites.service.js';
import type { AdminView } from './users.schemas.js';
import { UsersService } from './users.service.js';

type Access = 'admin' | 'super_admin';

const ADMIN_ROLES: Access[] = ['admin', 'super_admin'];
const accessLabel = (a: Access) =>
  a === 'super_admin' ? 'Super admin' : 'Admin';
const LAST_SUPER_ADMIN = 'There must be at least one Super admin';

type AdminRow = User & { invites: { sentAt: Date }[] };

/** Admin accounts (spec "Workspace settings, admins, audit"). Mutations are super-admin only. */
@Injectable()
export class AdminsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly invites: InvitesService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** Active admins and pending admin invites, oldest first. Removed admins are not listed. */
  async list(): Promise<AdminView[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        role: { in: ADMIN_ROLES },
        status: { in: ['active', 'invite_pending'] },
      },
      include: latestInvite,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAdminView);
  }

  /** Invites a new admin by email. The email must not belong to any user (409). */
  async invite(
    actor: AuthUser,
    input: { email: string; access: Access },
    ip: string | null,
  ): Promise<AdminView> {
    const taken = await this.prisma.unfiltered.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (taken) throw conflict('Already an admin or invited');
    const { inviteLinkExpiryDays } = await this.settings.get();
    const { user, token } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          role: input.access,
          status: 'invite_pending',
        },
      });
      const { token } = await this.invites.issueInvite(
        tx,
        { userId: user.id, email: user.email, invitedBy: actor.id },
        inviteLinkExpiryDays,
      );
      return { user, token };
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'Invited an admin',
      entity: 'user',
      entityId: user.id,
      itemLabel: user.email,
      after: { access: input.access },
      ip,
    });
    await this.invites.sendEmail(user.id, {
      template: 'admin-invite',
      to: user.email,
      vars: {
        link: this.invites.adminLink(user.email, token),
        access: input.access,
        expiresDays: inviteLinkExpiryDays,
      },
    });
    return toAdminView(await this.load(user.id));
  }

  async resend(actor: AuthUser, id: string, ip: string | null): Promise<void> {
    const admin = await this.load(id);
    if (admin.status !== 'invite_pending')
      throw validationFailed('Only a pending invite can be resent');
    const { inviteLinkExpiryDays } = await this.settings.get();
    const { token } = await this.prisma.$transaction((tx) =>
      this.invites.reissue(
        tx,
        { userId: admin.id, email: admin.email, invitedBy: actor.id },
        inviteLinkExpiryDays,
      ),
    );
    await this.audit.record({
      actorId: actor.id,
      action: 'Resent an admin invite',
      entity: 'user',
      entityId: admin.id,
      itemLabel: admin.email,
      ip,
    });
    await this.invites.sendEmail(admin.id, {
      template: 'admin-invite',
      to: admin.email,
      vars: {
        link: this.invites.adminLink(admin.email, token),
        access: admin.role as Access,
        expiresDays: inviteLinkExpiryDays,
      },
    });
  }

  /** Admin ↔ Super admin. Never demotes the last active Super admin, and never the caller. */
  async changeAccess(
    actor: AuthUser,
    id: string,
    access: Access,
    ip: string | null,
  ): Promise<AdminView> {
    if (id === actor.id)
      throw validationFailed('You can’t change your own access');
    const before = await this.prisma.$transaction(async (tx) => {
      await lockAdmins(tx);
      const admin = await this.load(id, tx);
      if (admin.role === access) return admin;
      if (admin.role === 'super_admin' && admin.status === 'active')
        await assertAnotherSuperAdmin(tx, admin.id);
      await tx.user.update({ where: { id }, data: { role: access } });
      return admin;
    });
    const from = before.role as Access;
    if (from !== access) {
      await this.audit.record({
        actorId: actor.id,
        action: 'Changed admin access',
        entity: 'user',
        entityId: id,
        itemLabel: `${before.name ?? before.email}: ${accessLabel(from)} → ${accessLabel(access)}`,
        before: { access: from },
        after: { access },
        ip,
      });
    }
    return toAdminView(await this.load(id));
  }

  /** Removes an admin: status revoked, pending invites withdrawn, signed out everywhere. */
  async remove(actor: AuthUser, id: string, ip: string | null): Promise<void> {
    if (id === actor.id) throw validationFailed('You can’t remove yourself');
    const admin = await this.prisma.$transaction(async (tx) => {
      await lockAdmins(tx);
      const admin = await this.load(id, tx);
      if (admin.role === 'super_admin' && admin.status === 'active')
        await assertAnotherSuperAdmin(tx, admin.id);
      await tx.user.update({ where: { id }, data: { status: 'revoked' } });
      await this.invites.revokePending(tx, id);
      return admin;
    });
    await this.users.revokeSessions(id);
    await this.audit.record({
      actorId: actor.id,
      action: 'Removed an admin',
      entity: 'user',
      entityId: id,
      itemLabel: admin.name ?? admin.email,
      before: { access: admin.role, status: admin.status },
      after: { status: 'revoked' },
      ip,
    });
  }

  /** A listed (active or pending) admin, else 404. */
  private async load(
    id: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<AdminRow> {
    const admin = await db.user.findFirst({
      where: {
        id,
        deletedAt: null,
        role: { in: ADMIN_ROLES },
        status: { in: ['active', 'invite_pending'] },
      },
      include: latestInvite,
    });
    if (!admin) throw notFound('Admin not found');
    return admin;
  }
}

const latestInvite = {
  invites: {
    orderBy: { sentAt: 'desc' },
    take: 1,
    select: { sentAt: true },
  },
} satisfies Prisma.UserInclude;

/** Serialises admin-count checks so two concurrent demotions can't remove the last Super admin. */
async function lockAdmins(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('preppilot:admins'))`;
}

async function assertAnotherSuperAdmin(
  tx: Prisma.TransactionClient,
  exceptId: string,
): Promise<void> {
  const others = await tx.user.count({
    where: {
      id: { not: exceptId },
      deletedAt: null,
      role: 'super_admin',
      status: 'active',
    },
  });
  if (others === 0) throw validationFailed(LAST_SUPER_ADMIN);
}

function toAdminView(user: AdminRow): AdminView {
  const invitedAt = user.invites[0]?.sentAt;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    ...(user.title ? { title: user.title } : {}),
    access: user.role === 'super_admin' ? 'super_admin' : 'admin',
    status: user.status === 'invite_pending' ? 'invite_pending' : 'active',
    lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
    ...(invitedAt ? { invitedAt: invitedAt.toISOString() } : {}),
  };
}
