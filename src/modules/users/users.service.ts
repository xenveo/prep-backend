import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { notFound, validationFailed } from '../../common/errors/app-error.js';
import {
  EVENT_BUS,
  type EventBus,
  USER_REVOKED_CHANNEL,
  type UserRevokedEvent,
} from '../../common/events/event-bus.types.js';
import { AppConfig } from '../../config/app-config.js';
import type { User } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { InvitesService } from './invites.service.js';
import type { UpdateCandidateBody } from './users.schemas.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Candidate account lifecycle and role assignments (FR-ADM-02..05), plus session revocation. */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly invites: InvitesService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  /**
   * Signs the user out everywhere at once: revokes every live auth session and tells the interview
   * gateway to close their sockets. Returns the number of sessions revoked.
   */
  async revokeSessions(userId: string): Promise<number> {
    const { count } = await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const event: UserRevokedEvent = { userId };
    await this.events.publish(USER_REVOKED_CHANNEL, event);
    return count;
  }

  /** A non-erased candidate, else 404. */
  async findCandidate(id: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: { id, role: 'candidate' },
    });
    if (!user) throw notFound('Candidate not found');
    return user;
  }

  /** Withdraws an invite before first login: invite_pending → revoked; its links stop working. */
  async revokeInvite(
    admin: AuthUser,
    id: string,
    ip: string | null,
  ): Promise<void> {
    const user = await this.findCandidate(id);
    if (user.status !== 'invite_pending')
      throw validationFailed('Only a pending invite can be revoked');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: 'revoked' } });
      await this.invites.revokePending(tx, id);
    });
    await this.revokeSessions(id);
    await this.activity.record(id, 'Invite revoked');
    await this.audit.record({
      actorId: admin.id,
      action: 'Revoked an invite',
      entity: 'user',
      entityId: id,
      itemLabel: user.name ?? user.email,
      before: { status: user.status },
      after: { status: 'revoked' },
      ip,
    });
  }

  /**
   * Turns accounts off (FR-ADM-04): active → deactivated, invite_pending → revoked. Sessions are
   * revoked at once, so an in-progress interview stops on its next call. Others are skipped.
   */
  async deactivate(
    admin: AuthUser,
    ids: string[],
    ip: string | null,
  ): Promise<{ deactivated: number; skipped: number }> {
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(ids)] },
        role: 'candidate',
        status: { in: ['active', 'invite_pending'] },
      },
      select: { id: true, status: true },
    });
    for (const user of users) {
      const pending = user.status === 'invite_pending';
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { status: pending ? 'revoked' : 'deactivated' },
        });
        if (pending) await this.invites.revokePending(tx, user.id);
      });
      await this.revokeSessions(user.id);
      await this.activity.record(
        user.id,
        pending ? 'Invite revoked' : 'Deactivated',
      );
    }
    const n = users.length;
    if (n > 0) {
      await this.audit.record({
        actorId: admin.id,
        action:
          n === 1 ? 'Deactivated a candidate' : `Deactivated ${n} candidates`,
        entity: 'user',
        entityId: n === 1 ? users[0].id : null,
        itemLabel: plural(n, 'candidate'),
        after: { candidateIds: users.map((u) => u.id) },
        ip,
      });
    }
    return { deactivated: n, skipped: ids.length - n };
  }

  /** Turns deactivated accounts back on: active, or invite_pending if they never logged in. */
  async reactivate(
    admin: AuthUser,
    ids: string[],
    ip: string | null,
  ): Promise<{ reactivated: number }> {
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(ids)] },
        role: 'candidate',
        status: 'deactivated',
      },
      select: { id: true, firstLoginAt: true },
    });
    for (const user of users) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { status: user.firstLoginAt ? 'active' : 'invite_pending' },
      });
      await this.activity.record(user.id, 'Reactivated');
    }
    const n = users.length;
    if (n > 0) {
      await this.audit.record({
        actorId: admin.id,
        action:
          n === 1 ? 'Reactivated a candidate' : `Reactivated ${n} candidates`,
        entity: 'user',
        entityId: n === 1 ? users[0].id : null,
        itemLabel: plural(n, 'candidate'),
        after: { candidateIds: users.map((u) => u.id) },
        ip,
      });
    }
    return { reactivated: n };
  }

  /** Name and access expiry (FR-ADM-05). */
  async updateCandidate(
    admin: AuthUser,
    id: string,
    body: UpdateCandidateBody,
    ip: string | null,
  ): Promise<void> {
    const user = await this.findCandidate(id);
    const data: { name?: string; accessExpiresAt?: Date | null } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.accessUntil !== undefined) data.accessExpiresAt = body.accessUntil;
    await this.prisma.user.update({ where: { id }, data });
    await this.audit.record({
      actorId: admin.id,
      action: 'Edited candidate',
      entity: 'user',
      entityId: id,
      itemLabel: data.name ?? user.name ?? user.email,
      before: {
        ...(data.name !== undefined ? { name: user.name } : {}),
        ...(data.accessExpiresAt !== undefined
          ? { accessUntil: user.accessExpiresAt?.toISOString() ?? null }
          : {}),
      },
      after: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.accessExpiresAt !== undefined
          ? { accessUntil: data.accessExpiresAt?.toISOString() ?? null }
          : {}),
      },
      ip,
    });
  }

  /**
   * Adds roles to candidates. Archived roles are rejected; live assignments are kept as they are; a
   * removed assignment is restored with the role's default limit. Approved roles are emailed to
   * active and invite-pending candidates.
   */
  async assignRoles(
    admin: AuthUser,
    ids: string[],
    roleIds: string[],
    ip: string | null,
  ): Promise<{ added: number }> {
    const candidateIds = [...new Set(ids)];
    const uniqueRoleIds = [...new Set(roleIds)];
    const [roles, users] = await Promise.all([
      this.prisma.jobRole.findMany({ where: { id: { in: uniqueRoleIds } } }),
      this.prisma.user.findMany({
        where: { id: { in: candidateIds }, role: 'candidate' },
      }),
    ]);
    if (roles.length !== uniqueRoleIds.length) throw notFound('Role not found');
    if (users.length !== candidateIds.length)
      throw notFound('Candidate not found');
    const archived = roles.find((r) => r.status === 'archived');
    if (archived) throw validationFailed(`${archived.title} is archived`);

    const existing = await this.prisma.roleAssignment.findMany({
      where: { userId: { in: candidateIds }, jobRoleId: { in: uniqueRoleIds } },
      select: { id: true, userId: true, jobRoleId: true, removedAt: true },
    });
    const byKey = new Map(
      existing.map((a) => [`${a.userId}/${a.jobRoleId}`, a]),
    );
    const added: { userId: string; roleId: string }[] = [];
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const user of users) {
        for (const role of roles) {
          const prior = byKey.get(`${user.id}/${role.id}`);
          if (prior && !prior.removedAt) continue;
          if (prior) {
            await tx.roleAssignment.update({
              where: { id: prior.id },
              data: {
                removedAt: null,
                assignedAt: now,
                assignedBy: admin.id,
                maxAttempts: null,
              },
            });
          } else {
            await tx.roleAssignment.create({
              data: {
                userId: user.id,
                jobRoleId: role.id,
                assignedBy: admin.id,
                assignedAt: now,
              },
            });
          }
          added.push({ userId: user.id, roleId: role.id });
        }
      }
    });

    const userById = new Map(users.map((u) => [u.id, u]));
    const roleById = new Map(roles.map((r) => [r.id, r]));
    for (const { userId, roleId } of added) {
      const user = userById.get(userId)!;
      const role = roleById.get(roleId)!;
      await this.activity.record(userId, `Assigned ${role.title}`);
      if (
        role.status === 'approved' &&
        (user.status === 'active' || user.status === 'invite_pending')
      ) {
        await this.invites.sendEmail(userId, {
          template: 'role-assigned',
          to: user.email,
          vars: {
            name: user.name ?? '',
            roleTitle: role.title,
            link: `${this.config.env.APP_CANDIDATE_ORIGIN}/roles/${encodeURIComponent(role.slug)}`,
          },
        });
      }
    }
    if (added.length > 0) {
      await this.audit.record({
        actorId: admin.id,
        action: 'Assigned roles',
        entity: 'role_assignment',
        entityId: null,
        itemLabel: plural(candidateIds.length, 'candidate'),
        after: { assignments: added },
        ip,
      });
    }
    return { added: added.length };
  }

  /** Soft-removes an assignment. Past sessions stay in reports. */
  async removeRole(
    admin: AuthUser,
    candidateId: string,
    roleId: string,
    ip: string | null,
  ): Promise<void> {
    const user = await this.findCandidate(candidateId);
    const assignment = await this.findAssignment(candidateId, roleId);
    await this.prisma.roleAssignment.update({
      where: { id: assignment.id },
      data: { removedAt: new Date() },
    });
    await this.activity.record(candidateId, `Removed ${assignment.role.title}`);
    await this.audit.record({
      actorId: admin.id,
      action: 'Removed a role',
      entity: 'user',
      entityId: candidateId,
      itemLabel: `${user.name ?? user.email} · ${assignment.role.title}`,
      before: { roleId, removedAt: null },
      ip,
    });
  }

  /** Per-assignment session limit; null falls back to the role's setting. */
  async updateAssignment(
    admin: AuthUser,
    candidateId: string,
    roleId: string,
    maxSessions: number | null,
    ip: string | null,
  ): Promise<void> {
    const user = await this.findCandidate(candidateId);
    const assignment = await this.findAssignment(candidateId, roleId);
    await this.prisma.roleAssignment.update({
      where: { id: assignment.id },
      data: { maxAttempts: maxSessions },
    });
    const show = (v: number | null) =>
      v === null ? 'Role default' : String(v);
    await this.audit.record({
      actorId: admin.id,
      action: 'Changed session limit',
      entity: 'user',
      entityId: candidateId,
      itemLabel: `${user.name ?? user.email} · ${assignment.role.title}: ${show(assignment.maxAttempts)} → ${show(maxSessions)}`,
      before: { roleId, maxSessions: assignment.maxAttempts },
      after: { roleId, maxSessions },
      ip,
    });
  }

  private async findAssignment(userId: string, jobRoleId: string) {
    const assignment = await this.prisma.roleAssignment.findFirst({
      where: { userId, jobRoleId, removedAt: null },
      include: { role: { select: { title: true } } },
    });
    if (!assignment) throw notFound('Role assignment not found');
    return assignment;
  }
}
