import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { AppConfig } from '../../config/app-config.js';
import { EmailService } from '../../jobs/email/email.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AssignmentsService } from './assignments.service.js';

const COOLDOWN_SEC = 24 * 60 * 60;

export type ReminderInput = { candidateIds: string[]; dryRun?: boolean };
export type ReminderRow = {
  candidateId: string;
  status: 'eligible' | 'queued' | 'ineligible' | 'cooldown' | 'queue_failed';
};
export type ReminderResult = {
  dryRun: boolean;
  eligible: number;
  queued: number;
  skipped: number;
  rows: ReminderRow[];
};

/** Fixed practice reminders for active candidates; pending invitees use the existing resend flow. */
@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly email: EmailService,
    private readonly rateLimiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async remind(
    admin: AuthUser,
    input: ReminderInput,
    ip: string | null,
  ): Promise<ReminderResult> {
    const ids = [...new Set(input.candidateIds)];
    const dryRun = input.dryRun ?? true;
    const rows: ReminderRow[] = [];
    let eligible = 0;
    const queued: string[] = [];

    for (const candidateId of ids) {
      const user = await this.eligibleCandidate(candidateId);
      if (!user) {
        rows.push({ candidateId, status: 'ineligible' });
        continue;
      }
      eligible++;
      if (dryRun) {
        rows.push({ candidateId, status: 'eligible' });
        continue;
      }

      // The key is per candidate, not per admin, so another admin cannot bypass the cooldown.
      const limit = await this.rateLimiter.consume(
        `practice-reminder:${candidateId}`,
        1,
        COOLDOWN_SEC,
      );
      if (!limit.allowed) {
        rows.push({ candidateId, status: 'cooldown' });
        continue;
      }
      // Eligibility can change while consuming the shared cooldown. Recheck before queueing and
      // use this current address, rather than retaining personal data from the first read.
      const current = await this.eligibleCandidate(candidateId);
      if (!current) {
        rows.push({ candidateId, status: 'ineligible' });
        continue;
      }
      try {
        await this.email.send({
          template: 'practice-reminder',
          to: current.email,
          vars: {
            name: current.name ?? '',
            link: `${this.config.env.APP_CANDIDATE_ORIGIN}/login`,
          },
        });
        queued.push(candidateId);
        rows.push({ candidateId, status: 'queued' });
      } catch {
        // A queue timeout can be ambiguous. Retain the cooldown so retries cannot immediately
        // send a duplicate, and never claim acceptance or delivery after a failed queue call.
        rows.push({ candidateId, status: 'queue_failed' });
      }
    }

    if (queued.length > 0) {
      await this.audit.record({
        actorId: admin.id,
        action: 'Sent practice reminders',
        entity: 'user',
        entityId: queued.length === 1 ? queued[0] : null,
        itemLabel: `${queued.length} practice reminder${queued.length === 1 ? '' : 's'} queued`,
        after: { candidateIds: queued, queued: queued.length },
        ip,
      });
    }
    return {
      dryRun,
      eligible,
      queued: queued.length,
      skipped: ids.length - (dryRun ? eligible : queued.length),
      rows,
    };
  }

  private async eligibleCandidate(candidateId: string) {
    const now = new Date();
    const user = await this.prisma.user.findFirst({
      where: {
        id: candidateId,
        role: 'candidate',
        status: 'active',
        deletedAt: null,
        OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }],
      },
      select: { id: true, name: true, email: true },
    });
    if (!user) return null;
    const roles = await this.assignments.listCandidateRoles(candidateId);
    if (roles.length === 0) return null;
    const stats = await this.assignments.getStatsForUser(candidateId);
    const byRole = new Map(stats.map((s) => [s.jobRoleId, s]));
    const canPractise = roles.some(({ assignment, role }) => {
      const left = this.assignments.attemptsLeft(
        assignment,
        role,
        byRole.get(role.id) ?? null,
      );
      return left === null || left > 0;
    });
    return canPractise ? user : null;
  }
}
