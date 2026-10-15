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
      this.prisma.user.findMany({ select: { email: true } }),
    ]);
    return {
      approvedRoleNames: roles
        .filter((r) => r.status === 'approved')
        .map((r) => r.title),
      draftRoleNames: roles
        .filter((r) => r.status === 'draft')
        .map((r) => r.title),
      existingEmails: users.map((u) => u.email),
    };
  }

  /** Authoritative CSV check: `already_invited` means a (non-erased) user has the email. */
  async validate(
    rows: InviteRowInput[],
  ): Promise<{ rows: InviteRow[]; summary: InviteSummary }> {
    const [roles, users] = await Promise.all([
      this.prisma.jobRole.findMany({
        where: { status: { in: ['approved', 'draft'] } },
        select: { title: true, status: true },
      }),
      this.prisma.user.findMany({
        where: {
          email: { in: rows.map((r) => r.email.trim()).filter(isValidEmail) },
        },
        select: { email: true },
      }),
    ]);
    const result = validateInviteRows(rows, {
      approvedRoleNames: roles
        .filter((r) => r.status === 'approved')
        .map((r) => r.title),
      draftRoleNames: roles
        .filter((r) => r.status === 'draft')
        .map((r) => r.title),
      existingEmails: users.map((u) => u.email),
    });
    return { rows: result, summary: summariseInviteRows(result) };
  }

  /**
   * Creates an invite-pending candidate per valid row, with role assignments and an invite link,
   * then emails them. Rows with a bad or taken email, no roles, or a role that isn't approved are
   * skipped.
   */
  async invite(
    admin: AuthUser,
    body: InviteBatchBody,
    ip: string | null,
  ): Promise<InviteBatchResult> {
    const roleIds = [...new Set(body.rows.flatMap((r) => r.roleIds))];
    const [roles, taken] = await Promise.all([
      this.prisma.jobRole.findMany({
        where: { id: { in: roleIds.filter(isUuid) }, status: 'approved' },
        select: { id: true, title: true },
      }),
      // Erased-but-not-purged users still hold their email, so check without the erasure filter.
      this.prisma.unfiltered.user.findMany({
        where: {
          email: {
            in: body.rows.map((r) => r.email.trim()).filter(isValidEmail),
          },
        },
        select: { email: true },
      }),
    ]);
    const approved = new Map(roles.map((r) => [r.id, r.title]));
    const used = new Set(taken.map((u) => u.email.toLowerCase()));

    const ready: { email: string; name: string | null; roleIds: string[] }[] =
      [];
    for (const row of body.rows) {
      const email = row.email.trim().toLowerCase();
      const ids = [...new Set(row.roleIds)];
      const ok =
        isValidEmail(email) &&
        !used.has(email) &&
        ids.length > 0 &&
        ids.every((id) => approved.has(id));
      if (!ok) continue;
      used.add(email);
      ready.push({ email, name: row.name.trim() || null, roleIds: ids });
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
    const created: {
      id: string;
      email: string;
      name: string | null;
      roleIds: string[];
      token: string;
    }[] = [];
    for (const row of ready) {
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
    await this.audit.record({
      actorId: admin.id,
      action: `Sent ${sent === 1 ? '1 invite' : `${sent} invites`}`,
      entity: 'invite_batch',
      entityId: batch.id,
      itemLabel: body.fileName ?? body.rows[0]?.email.trim() ?? 'Invite',
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
        action: resent === 1 ? 'Resent an invite' : `Resent ${resent} invites`,
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
