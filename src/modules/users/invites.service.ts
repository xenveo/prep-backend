import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { randomToken, sha256Hex } from '../../common/crypto.js';
import { AppConfig } from '../../config/app-config.js';
import { Prisma } from '../../generated/prisma/client.js';
import { type EmailJob, EmailService } from '../../jobs/email/email.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  canReinvite,
  isValidEmail,
  summariseInviteRows,
  validateInviteRows,
} from './invite-validation.js';
import {
  idSchema,
  type InviteBatchBody,
  type InviteBatchResult,
  type InviteContext,
  type InviteRow,
  type InviteRowInput,
  type InviteSummary,
} from './users.schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type Db = PrismaService | Prisma.TransactionClient;

type ReadyRow = {
  email: string;
  name: string | null;
  roleIds: string[];
  /** A revoked candidate being invited again: their row is reused instead of created. */
  reuseId: string | null;
};

export type IssuedInvite = { token: string; expiresDays: number };

/** Invites (FR-ADM-01..03, 05): CSV checks, batches, resends, and the invite tokens admins share. */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    private readonly email: EmailService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  /** Role names and emails in use, for the admin UI's client-side CSV parse. */
  async getContext(): Promise<InviteContext> {
    const [roles, users] = await Promise.all([
      this.prisma.jobRole.findMany({
        where: { status: { in: ['approved', 'draft'] } },
        select: { title: true, status: true },
        orderBy: { title: 'asc' },
      }),
      this.emailOwners(),
    ]);
    return {
      approvedRoleNames: roles
        .filter((r) => r.status === 'approved')
        .map((r) => r.title),
      draftRoleNames: roles
        .filter((r) => r.status === 'draft')
        .map((r) => r.title),
      // Hidden users' emails never reach the client; `validate` still reports them as taken.
      existingEmails: takenEmails(users.filter((u) => u.deletedAt === null)),
    };
  }

  /**
   * Authoritative CSV check: `already_invited` means a user holds the email, erased-but-not-purged
   * ones included, unless they are a revoked candidate who may be invited again.
   */
  async validate(
    rows: InviteRowInput[],
  ): Promise<{ rows: InviteRow[]; summary: InviteSummary }> {
    const [roles, users] = await Promise.all([
      this.prisma.jobRole.findMany({
        where: { status: { in: ['approved', 'draft'] } },
        select: { title: true, status: true },
      }),
      this.emailOwners(rows.map((r) => r.email.trim()).filter(isValidEmail)),
    ]);
    const result = validateInviteRows(rows, {
      approvedRoleNames: roles
        .filter((r) => r.status === 'approved')
        .map((r) => r.title),
      draftRoleNames: roles
        .filter((r) => r.status === 'draft')
        .map((r) => r.title),
      existingEmails: takenEmails(users),
    });
    return { rows: result, summary: summariseInviteRows(result) };
  }

  /**
   * Creates an invite-pending candidate per valid row, with role assignments and an invite link,
   * then emails them. A revoked candidate's row is reused the same way. Rows with a bad or taken
   * email, no roles, or a role that isn't approved are skipped.
   */
  async invite(
    admin: AuthUser,
    body: InviteBatchBody,
    ip: string | null,
  ): Promise<InviteBatchResult> {
    const roleIds = [...new Set(body.rows.flatMap((r) => r.roleIds))];
    const [roles, owners] = await Promise.all([
      this.prisma.jobRole.findMany({
        where: { id: { in: roleIds.filter(isUuid) }, status: 'approved' },
        select: { id: true, title: true },
      }),
      this.emailOwners(
        body.rows.map((r) => r.email.trim()).filter(isValidEmail),
      ),
    ]);
    const approved = new Map(roles.map((r) => [r.id, r.title]));
    const used = new Set(takenEmails(owners).map((e) => e.toLowerCase()));
    const reusable = new Map(
      owners.filter(canReinvite).map((u) => [u.email.toLowerCase(), u]),
    );

    const ready: ReadyRow[] = [];
    for (const row of body.rows) {
      const key = row.email.trim().toLowerCase();
      const ids = [...new Set(row.roleIds)];
      const ok =
        isValidEmail(key) &&
        !used.has(key) &&
        ids.length > 0 &&
        ids.every((id) => approved.has(id));
      if (!ok) continue;
      used.add(key);
      const prior = reusable.get(key);
      ready.push({
        email: prior?.email ?? key,
        name: row.name.trim() || null,
        roleIds: ids,
        reuseId: prior?.id ?? null,
      });
    }

    const batch = await this.prisma.inviteBatch.create({
      data: {
        createdBy: admin.id,
        source: body.source,
        fileName: body.fileName ?? null,
        sent: 0,
        skipped: 0,
      },
    });
    const { inviteLinkExpiryDays } = await this.settings.get();
    const created: (ReadyRow & { id: string; token: string })[] = [];
    for (const row of ready) {
      const { reuseId } = row;
      if (reuseId) {
        const token = await this.prisma.$transaction((tx) =>
          this.reinviteRevoked(
            tx,
            { ...row, id: reuseId },
            body,
            admin.id,
            inviteLinkExpiryDays,
            batch.id,
          ),
        );
        // Changed concurrently (e.g. erased or invited by someone else): skip the row.
        if (token) created.push({ ...row, id: reuseId, token });
        continue;
      }
      try {
        const made = await this.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email: row.email,
              name: row.name,
              role: 'candidate',
              status: 'invite_pending',
              accessExpiresAt: body.accessUntil ?? null,
            },
          });
          const { token } = await this.issueInvite(
            tx,
            { userId: user.id, email: user.email, invitedBy: admin.id },
            inviteLinkExpiryDays,
            batch.id,
          );
          await tx.roleAssignment.createMany({
            data: row.roleIds.map((jobRoleId) => ({
              userId: user.id,
              jobRoleId,
              assignedBy: admin.id,
              maxAttempts: body.maxSessions ?? null,
            })),
          });
          return { id: user.id, token };
        });
        created.push({ ...row, ...made });
      } catch (err) {
        // A concurrent invite took the email: skip the row like any other taken address.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        )
          continue;
        throw err;
      }
    }

    const sent = created.length;
    const skipped = body.rows.length - sent;
    await this.prisma.inviteBatch.update({
      where: { id: batch.id },
      data: { sent, skipped },
    });
    const source = body.fileName ?? body.rows[0]?.email.trim();
    const count = `${sent} invite${sent === 1 ? '' : 's'}`;
    await this.audit.record({
      actorId: admin.id,
      action: 'Sent invites',
      entity: 'invite_batch',
      entityId: batch.id,
      itemLabel: source ? `${count} · ${source}` : count,
      after: { sent, skipped, candidateIds: created.map((c) => c.id) },
      ip,
    });

    const invitedBy = `Invited by ${admin.name ?? 'an admin'}`;
    for (const c of created) {
      await this.activity.record(c.id, invitedBy);
      await this.sendEmail(c.id, {
        template: 'candidate-invite',
        to: c.email,
        vars: {
          name: c.name ?? '',
          link: this.candidateLink(c.email, c.token),
          expiresDays: inviteLinkExpiryDays,
          roleTitles: c.roleIds.map((id) => approved.get(id) ?? ''),
        },
      });
    }
    return {
      batchId: batch.id,
      sent,
      skipped,
      candidateIds: created.map((c) => c.id),
    };
  }

  /** Users holding any of `emails` (all users when omitted), erased-but-not-purged ones included. */
  private emailOwners(emails?: string[]) {
    return this.prisma.unfiltered.user.findMany({
      where: emails ? { email: { in: emails } } : {},
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        deletedAt: true,
      },
    });
  }

  /**
   * Turns a revoked candidate back into a pending invite with the row's name, roles and limits, as a
   * new invite would have them: other roles are removed, earlier links stay dead and a fresh one is
   * issued. Returns its token, or null if the user is no longer a revoked, non-erased candidate.
   */
  private async reinviteRevoked(
    tx: Prisma.TransactionClient,
    user: { id: string; email: string; name: string | null; roleIds: string[] },
    body: InviteBatchBody,
    adminId: string,
    expiresDays: number,
    batchId: string,
  ): Promise<string | null> {
    const { count } = await tx.user.updateMany({
      where: {
        id: user.id,
        role: 'candidate',
        status: 'revoked',
        deletedAt: null,
      },
      data: {
        name: user.name,
        status: 'invite_pending',
        accessExpiresAt: body.accessUntil ?? null,
      },
    });
    if (count === 0) return null;
    const now = new Date();
    await tx.roleAssignment.updateMany({
      where: {
        userId: user.id,
        removedAt: null,
        jobRoleId: { notIn: user.roleIds },
      },
      data: { removedAt: now },
    });
    for (const jobRoleId of user.roleIds) {
      const assignment = {
        assignedBy: adminId,
        assignedAt: now,
        maxAttempts: body.maxSessions ?? null,
      };
      await tx.roleAssignment.upsert({
        where: { userId_jobRoleId: { userId: user.id, jobRoleId } },
        update: { ...assignment, removedAt: null },
        create: { ...assignment, userId: user.id, jobRoleId },
      });
    }
    await tx.invite.updateMany({
      where: { userId: user.id, status: 'pending' },
      data: { status: 'expired' },
    });
    const { token } = await this.issueInvite(
      tx,
      { userId: user.id, email: user.email, invitedBy: adminId },
      expiresDays,
      batchId,
    );
    return token;
  }

  /** Re-sends invites to invite-pending candidates: earlier links expire and a fresh one is mailed. */
  async resend(
    admin: AuthUser,
    candidateIds: string[],
    ip: string | null,
  ): Promise<{ resent: number; skipped: number }> {
    const ids = [...new Set(candidateIds)];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, role: 'candidate', status: 'invite_pending' },
      include: {
        assignments: {
          where: { removedAt: null, role: { status: 'approved' } },
          select: { role: { select: { title: true } } },
        },
      },
    });
    const { inviteLinkExpiryDays } = await this.settings.get();
    for (const user of users) {
      const { token } = await this.prisma.$transaction((tx) =>
        this.reissue(
          tx,
          { userId: user.id, email: user.email, invitedBy: admin.id },
          inviteLinkExpiryDays,
        ),
      );
      await this.activity.record(user.id, 'Invite resent');
      await this.sendEmail(user.id, {
        template: 'candidate-invite',
        to: user.email,
        vars: {
          name: user.name ?? '',
          link: this.candidateLink(user.email, token),
          expiresDays: inviteLinkExpiryDays,
          roleTitles: user.assignments.map((a) => a.role.title),
        },
      });
    }
    const resent = users.length;
    if (resent > 0) {
      await this.audit.record({
        actorId: admin.id,
        action: 'Resent invites',
        entity: 'user',
        entityId: resent === 1 ? users[0].id : null,
        itemLabel: `${resent} candidate${resent === 1 ? '' : 's'}`,
        after: { candidateIds: users.map((u) => u.id) },
        ip,
      });
    }
    return { resent, skipped: candidateIds.length - resent };
  }

  /** A new pending invite (token stored as its sha256). Returns the raw token for the email link. */
  async issueInvite(
    db: Db,
    target: { userId: string; email: string; invitedBy: string },
    expiresDays: number,
    batchId: string | null = null,
  ): Promise<IssuedInvite> {
    const token = randomToken();
    const now = new Date();
    await db.invite.create({
      data: {
        email: target.email,
        userId: target.userId,
        invitedBy: target.invitedBy,
        batchId,
        tokenHash: sha256Hex(token),
        sentAt: now,
        expiresAt: new Date(now.getTime() + expiresDays * DAY_MS),
      },
    });
    return { token, expiresDays };
  }

  /** Expires the user's pending invites and issues a fresh one (resend). */
  async reissue(
    db: Db,
    target: { userId: string; email: string; invitedBy: string },
    expiresDays: number,
  ): Promise<IssuedInvite> {
    await db.invite.updateMany({
      where: { userId: target.userId, status: 'pending' },
      data: { status: 'expired' },
    });
    return this.issueInvite(db, target, expiresDays);
  }

  /** Withdraws every pending invite of a user, so their links stop working. */
  async revokePending(db: Db, userId: string): Promise<void> {
    await db.invite.updateMany({
      where: { userId, status: 'pending' },
      data: { status: 'revoked' },
    });
  }

  candidateLink(email: string, token: string): string {
    return loginLink(this.config.env.APP_CANDIDATE_ORIGIN, email, token);
  }

  adminLink(email: string, token: string): string {
    return loginLink(this.config.env.APP_ADMIN_ORIGIN, email, token);
  }

  /** Queues an email; a queue failure is logged (user id only) and doesn't fail the admin action. */
  async sendEmail(userId: string, job: EmailJob): Promise<void> {
    try {
      await this.email.send(job);
    } catch (err) {
      this.logger.error(
        { userId, template: job.template, err },
        'Failed to enqueue email',
      );
    }
  }
}

function loginLink(origin: string, email: string, token: string): string {
  return `${origin}/login/code?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
}

const isUuid = (id: string) => idSchema.safeParse(id).success;

/** Emails that can't be invited: every owner except a revoked candidate who may be invited again. */
const takenEmails = (
  owners: {
    email: string;
    role: string;
    status: string;
    deletedAt: Date | null;
  }[],
) => owners.filter((u) => !canReinvite(u)).map((u) => u.email);
