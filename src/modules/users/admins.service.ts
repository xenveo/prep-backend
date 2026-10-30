import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  ADMIN_ACCESS,
  adminAccessOf,
  hasAdminAccess,
  type AdminAccess,
} from '../../common/auth/admin-access.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  conflict,
  notFound,
  validationFailed,
} from '../../common/errors/app-error.js';
import type {
  Prisma,
  User,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { InvitesService } from './invites.service.js';
import type { AdminView } from './users.schemas.js';
import { UsersService } from './users.service.js';

const accessLabel = (a: AdminAccess) =>
  a === 'super_admin' ? 'Super admin' : 'Admin';
const LAST_SUPER_ADMIN = 'There must be at least one Super admin';
const EMAIL_TAKEN = 'Already an admin or invited';

/** Statuses of a listed admin (active or invite pending). */
const LISTED_STATUSES: UserStatus[] = ['active', 'invite_pending'];
/** Statuses of a removed admin, whose row a new invite reuses (remove() sets `revoked`). */
const REMOVED_STATUSES: UserStatus[] = ['revoked', 'deactivated'];
const REMOVED_ADMIN = {
  deletedAt: null,
  role: { in: ADMIN_ACCESS },
  status: { in: REMOVED_STATUSES },
} satisfies Prisma.UserWhereInput;
/** A candidate who can be granted admin access: listed, not erased, no admin access yet. */
const GRANTABLE_CANDIDATE = {
  deletedAt: null,
  role: 'candidate',
  adminRole: null,
  status: { in: LISTED_STATUSES },
} satisfies Prisma.UserWhereInput;

type AdminRow = User & { invites: { sentAt: Date }[] };
type ListedAdmin = AdminRow & { access: AdminAccess };

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

  /**
   * Active admins and pending admin invites (admin accounts and candidates with admin access),
   * oldest first. Removed admins are not listed.
   */
  async list(): Promise<AdminView[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        status: { in: LISTED_STATUSES },
        ...hasAdminAccess(),
      },
      include: latestInvite,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAdminView);
  }

  /**
   * Invites an admin by email. A removed admin (revoked or deactivated) is re-invited on their
   * existing row. An active or pending candidate is granted admin access on their own account
   * (`adminRole`) and gets an admin login link; their role, status, sessions and any pending
   * candidate invite are untouched. Any other user with the email is a 409.
   */
  async invite(
    actor: AuthUser,
    input: { email: string; access: AdminAccess },
    ip: string | null,
  ): Promise<AdminView> {
    const existing = await this.prisma.unfiltered.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        email: true,
        role: true,
        adminRole: true,
        status: true,
        deletedAt: true,
      },
    });
    const reinvite = existing !== null && isRemovedAdmin(existing);
    const grant = existing !== null && isGrantableCandidate(existing);
    if (existing && !reinvite && !grant) throw conflict(EMAIL_TAKEN);
    const { inviteLinkExpiryDays } = await this.settings.get();
    const { user, token } = await this.prisma.$transaction(async (tx) => {
      if (!existing) {
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
      }
      if (grant) {
        // Conditional, so a concurrent grant can't issue a second link. Not a reissue: the
        // candidate's own pending invite link must keep working.
        const { count } = await tx.user.updateMany({
          where: { id: existing.id, ...GRANTABLE_CANDIDATE },
          data: { adminRole: input.access },
        });
        if (count === 0) throw conflict(EMAIL_TAKEN);
        const { token } = await this.invites.issueInvite(
          tx,
          { userId: existing.id, email: existing.email, invitedBy: actor.id },
          inviteLinkExpiryDays,
        );
        return { user: existing, token };
      }
      // Conditional on still being removed, so a concurrent re-invite can't issue a second link.
      const { count } = await tx.user.updateMany({
        where: { id: existing.id, ...REMOVED_ADMIN },
        data: { role: input.access, status: 'invite_pending' },
      });
      if (count === 0) throw conflict(EMAIL_TAKEN);
      const { token } = await this.invites.reissue(
        tx,
        { userId: existing.id, email: existing.email, invitedBy: actor.id },
        inviteLinkExpiryDays,
      );
      return { user: existing, token };
    });
    // Removal already signed them out; this guarantees no old session revives once they accept.
    if (reinvite) await this.users.revokeSessions(user.id);
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
        access: admin.access,
        expiresDays: inviteLinkExpiryDays,
      },
    });
  }

  /** Admin ↔ Super admin. Never demotes the last active Super admin, and never the caller. */
  async changeAccess(
    actor: AuthUser,
    id: string,
    access: AdminAccess,
    ip: string | null,
  ): Promise<AdminView> {
    if (id === actor.id)
      throw validationFailed('You can’t change your own access');
    const before = await this.prisma.$transaction(async (tx) => {
      await lockAdmins(tx);
      const admin = await this.load(id, tx);
      if (admin.access === access) return admin;
      if (admin.access === 'super_admin' && admin.status === 'active')
        await assertAnotherSuperAdmin(tx, admin.id);
      await tx.user.update({
        where: { id },
        data:
          admin.role === 'candidate' ? { adminRole: access } : { role: access },
      });
      return admin;
    });
    const from = before.access;
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

  /**
   * Removes an admin: status revoked, pending invites withdrawn, signed out everywhere. A candidate
   * with admin access only loses it (`adminRole` cleared) and keeps their candidate account and
   * invites; they are still signed out so admin sessions end.
   */
  async remove(actor: AuthUser, id: string, ip: string | null): Promise<void> {
    if (id === actor.id) throw validationFailed('You can’t remove yourself');
    const admin = await this.prisma.$transaction(async (tx) => {
      await lockAdmins(tx);
      const admin = await this.load(id, tx);
      if (admin.access === 'super_admin' && admin.status === 'active')
        await assertAnotherSuperAdmin(tx, admin.id);
      if (admin.role === 'candidate') {
        await tx.user.update({ where: { id }, data: { adminRole: null } });
      } else {
        await tx.user.update({ where: { id }, data: { status: 'revoked' } });
        await this.invites.revokePending(tx, id);
      }
      return admin;
    });
    await this.users.revokeSessions(id);
    await this.audit.record({
      actorId: actor.id,
      action: 'Removed an admin',
      entity: 'user',
      entityId: id,
      itemLabel: admin.name ?? admin.email,
      before: { access: admin.access, status: admin.status },
      after:
        admin.role === 'candidate' ? { access: null } : { status: 'revoked' },
      ip,
    });
  }

  /** A listed (active or pending) admin, else 404. */
  private async load(
    id: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<ListedAdmin> {
    const admin = await db.user.findFirst({
      where: {
        id,
        deletedAt: null,
        status: { in: LISTED_STATUSES },
        ...hasAdminAccess(),
      },
      include: latestInvite,
    });
    const access = admin && adminAccessOf(admin);
    if (!admin || !access) throw notFound('Admin not found');
    return { ...admin, access };
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
      status: 'active',
      ...hasAdminAccess(['super_admin']),
    },
  });
  if (others === 0) throw validationFailed(LAST_SUPER_ADMIN);
}

function isRemovedAdmin(
  user: Pick<User, 'role' | 'status' | 'deletedAt'>,
): boolean {
  return (
    user.deletedAt === null &&
    (ADMIN_ACCESS as string[]).includes(user.role) &&
    REMOVED_STATUSES.includes(user.status)
  );
}

function isGrantableCandidate(
  user: Pick<User, 'role' | 'adminRole' | 'status' | 'deletedAt'>,
): boolean {
  return (
    user.deletedAt === null &&
    user.role === 'candidate' &&
    user.adminRole === null &&
    LISTED_STATUSES.includes(user.status)
  );
}

function toAdminView(user: AdminRow): AdminView {
  const invitedAt = user.invites[0]?.sentAt;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    ...(user.title ? { title: user.title } : {}),
    access: adminAccessOf(user) === 'super_admin' ? 'super_admin' : 'admin',
    status: user.status === 'invite_pending' ? 'invite_pending' : 'active',
    lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
    ...(invitedAt ? { invitedAt: invitedAt.toISOString() } : {}),
  };
}
