import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../adapters/storage/storage.adapter.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { notFound } from '../../common/errors/app-error.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { AppConfig } from '../../config/app-config.js';
import { EmailService } from '../../jobs/email/email.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  candidateBundle,
  candidatesCsv,
  scoresCsv,
  sessionsCsv,
  type DimensionScores,
} from './export-builders.js';
import {
  candidateExportKey,
  EXPORT_LINK_TTL_SEC,
  WORKSPACE_EXPORT_FILES,
  workspaceExportPrefix,
} from './export-files.js';
import { requireUuid } from './ids.js';

/** `export` job. `privacyRequestId` is the candidate request it fulfils, if any. */
export type ExportJobData = { exportJobId: string; privacyRequestId?: string };

export type ExportKind = 'workspace_csv' | 'candidate_json';

/** The admin UI's action string for "Export all data". */
export const EXPORT_AUDIT_ACTION = 'Exported all data';

export type WorkspaceExportView = {
  /** queued | running | done | failed | expired (files deleted or the 24 h window passed) */
  status: string;
  files: { name: string; url: string }[];
};

const EXPORT_LINK_TTL_MS = EXPORT_LINK_TTL_SEC * 1000;

/** Workspace CSV and candidate JSON exports (plan §8 `export`, NFR-06). */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly config: AppConfig,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  /** POST /admin/exports: queues the CSV build, records `lastExportAt` and audits it. */
  async startWorkspaceExport(
    actorId: string,
    ip: string | null,
  ): Promise<{ exportId: string; lastExportAt: string }> {
    const job = await this.enqueue('workspace_csv', actorId, null);
    const lastExportAt = job.createdAt.toISOString();
    await this.settings.update({ lastExportAt });
    await this.audit.record({
      actorId,
      action: EXPORT_AUDIT_ACTION,
      entity: 'export_job',
      entityId: job.id,
      itemLabel: 'Workspace',
      ip,
    });
    return { exportId: job.id, lastExportAt };
  }

  /** Queues a candidate's JSON bundle; the link is emailed to the candidate. */
  async startCandidateExport(
    subjectId: string,
    requestedBy: string,
    privacyRequestId?: string,
  ): Promise<string> {
    const job = await this.enqueue(
      'candidate_json',
      requestedBy,
      subjectId,
      privacyRequestId,
    );
    return job.id;
  }

  /** GET /admin/exports/:id: status and 24 h signed links to the CSVs. */
  async getWorkspaceExport(
    id: string,
    now = new Date(),
  ): Promise<WorkspaceExportView> {
    const job = await this.prisma.exportJob.findFirst({
      where: {
        id: requireUuid(id, 'Export not found'),
        kind: 'workspace_csv',
      },
    });
    if (!job) throw notFound('Export not found');
    if (job.status !== 'done') return { status: job.status, files: [] };
    const fresh =
      job.fileKey &&
      job.finishedAt &&
      now.getTime() - job.finishedAt.getTime() < EXPORT_LINK_TTL_MS;
    if (!fresh) return { status: 'expired', files: [] };
    const files = await Promise.all(
      WORKSPACE_EXPORT_FILES.map(async (name) => ({
        name,
        url: await this.storage.signedUrl(
          `${job.fileKey}${name}`,
          EXPORT_LINK_TTL_SEC,
        ),
      })),
    );
    return { status: 'done', files };
  }

  /** The `export` job processor. */
  async run(data: ExportJobData, now = new Date()): Promise<void> {
    const job = await this.prisma.exportJob.findUnique({
      where: { id: data.exportJobId },
    });
    if (!job || job.status === 'done') return;
    await this.prisma.exportJob.update({
      where: { id: job.id },
      data: { status: 'running' },
    });
    try {
      const delivered =
        job.kind === 'workspace_csv'
          ? await this.buildWorkspace(job.id, job.requestedBy)
          : await this.buildCandidate(job.id, job.subjectId, now);
      await this.prisma.exportJob.update({
        where: { id: job.id },
        data: delivered
          ? { status: 'done', fileKey: delivered, finishedAt: new Date() }
          : { status: 'failed', finishedAt: new Date() },
      });
      if (delivered && data.privacyRequestId) {
        await this.prisma.privacyRequest.updateMany({
          where: { id: data.privacyRequestId, status: 'pending' },
          data: { status: 'completed', completedAt: new Date() },
        });
      }
    } catch (err) {
      await this.prisma.exportJob.update({
        where: { id: job.id },
        data: { status: 'failed', finishedAt: new Date() },
      });
      throw err;
    }
  }

  private async enqueue(
    kind: ExportKind,
    requestedBy: string,
    subjectId: string | null,
    privacyRequestId?: string,
  ) {
    const job = await this.prisma.exportJob.create({
      data: { kind, requestedBy, subjectId, status: 'queued' },
    });
    await this.queue.add<ExportJobData>(
      'export',
      { exportJobId: job.id, privacyRequestId },
      { jobId: `export-${job.id}`, attempts: 3, backoffMs: 5000 },
    );
    return job;
  }

  /** Candidates, sessions and scores of visible users; no audio, no transcripts. Emails the admin. */
  private async buildWorkspace(
    jobId: string,
    requestedBy: string,
  ): Promise<string | null> {
    const [candidates, sessions, attempts] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'candidate' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          firstLoginAt: true,
          lastActiveAt: true,
          accessExpiresAt: true,
          assignments: {
            where: { removedAt: null },
            select: { role: { select: { title: true } } },
          },
          invites: {
            orderBy: { sentAt: 'asc' },
            take: 1,
            select: { sentAt: true },
          },
        },
      }),
      this.prisma.session.findMany({
        where: { isPreview: false, user: { role: 'candidate' } },
        orderBy: { startedAt: 'asc' },
        include: { role: { select: { title: true } } },
      }),
      this.prisma.attempt.findMany({
        where: { session: { isPreview: false, user: { role: 'candidate' } } },
        orderBy: { submittedAt: 'asc' },
        select: {
          id: true,
          sessionId: true,
          attemptNo: true,
          mode: true,
          status: true,
          score: true,
          learningScore: true,
          dimensionScores: true,
          wpm: true,
          fillerCount: true,
          pauseCount: true,
          longestPauseS: true,
          durationS: true,
          submittedAt: true,
          question: { select: { text: true } },
          session: {
            select: { userId: true, role: { select: { title: true } } },
          },
        },
      }),
    ]);

    const prefix = workspaceExportPrefix(jobId);
    const files: Record<(typeof WORKSPACE_EXPORT_FILES)[number], string> = {
      'candidates.csv': candidatesCsv(
        candidates.map((c) => ({
          ...c,
          roles: c.assignments.map((a) => a.role.title),
          invitedAt: c.invites[0]?.sentAt ?? null,
        })),
      ),
      'sessions.csv': sessionsCsv(
        sessions.map((s) => ({ ...s, role: s.role.title })),
      ),
      'scores.csv': scoresCsv(
        attempts.map((a) => ({
          ...a,
          userId: a.session.userId,
          role: a.session.role.title,
          question: a.question.text,
          dimensionScores: a.dimensionScores as DimensionScores | null,
        })),
      ),
    };
    for (const name of WORKSPACE_EXPORT_FILES)
      await this.storage.put(
        `${prefix}${name}`,
        Buffer.from(files[name]),
        'text/csv; charset=utf-8',
      );

    const admin = await this.prisma.user.findUnique({
      where: { id: requestedBy },
      select: { email: true },
    });
    if (admin) {
      const link = `${this.config.env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/admin/exports/${jobId}`;
      await this.email.send({
        template: 'export-ready',
        to: admin.email,
        vars: { link, expiresHours: EXPORT_LINK_TTL_SEC / 3600 },
      });
    }
    this.logger.log(`Workspace export ${jobId} built`);
    return prefix;
  }

  /** The subject's JSON bundle, emailed to them. Null (job failed) when they are gone or hidden. */
  private async buildCandidate(
    jobId: string,
    subjectId: string | null,
    now: Date,
  ): Promise<string | null> {
    const user = subjectId
      ? await this.prisma.user.findUnique({
          where: { id: subjectId },
          select: CANDIDATE_EXPORT_SELECT,
        })
      : null;
    if (!user) {
      this.logger.warn(`Candidate export ${jobId}: subject not available`);
      return null;
    }
    const key = candidateExportKey(jobId);
    const body = JSON.stringify(candidateBundle(user, now), null, 2);
    await this.storage.put(key, Buffer.from(body), 'application/json');
    const link = await this.storage.signedUrl(key, EXPORT_LINK_TTL_SEC);
    await this.email.send({
      template: 'export-ready',
      to: user.email,
      vars: { link, expiresHours: EXPORT_LINK_TTL_SEC / 3600 },
    });
    this.logger.log(`Candidate export ${jobId} built for user ${user.id}`);
    return key;
  }
}

/** Everything the candidate bundle needs and nothing else: no audio keys, no word timings. */
const CANDIDATE_EXPORT_SELECT = {
  id: true,
  email: true,
  name: true,
  title: true,
  role: true,
  status: true,
  accessExpiresAt: true,
  firstLoginAt: true,
  lastActiveAt: true,
  createdAt: true,
  assignments: {
    orderBy: { assignedAt: 'asc' },
    select: {
      assignedAt: true,
      maxAttempts: true,
      removedAt: true,
      role: { select: { title: true } },
    },
  },
  sessions: {
    where: { isPreview: false },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      number: true,
      status: true,
      mode: true,
      startedAt: true,
      completedAt: true,
      durationS: true,
      score: true,
      band: true,
      firstTryAvg: true,
      retryAvg: true,
      learningAvg: true,
      skills: true,
      strengths: true,
      focusAreas: true,
      bandMessage: true,
      role: { select: { title: true } },
      attempts: {
        orderBy: { submittedAt: 'asc' },
        select: {
          id: true,
          attemptNo: true,
          mode: true,
          status: true,
          transcript: true,
          durationS: true,
          wpm: true,
          fillerCount: true,
          pauseCount: true,
          longestPauseS: true,
          dimensionScores: true,
          score: true,
          learningScore: true,
          feedback: true,
          feedbackText: true,
          submittedAt: true,
          question: { select: { text: true } },
        },
      },
    },
  },
  consents: {
    orderBy: { givenAt: 'asc' },
    select: { kind: true, textVersion: true, givenAt: true },
  },
  activityEvents: { orderBy: { at: 'asc' }, select: { text: true, at: true } },
  cardViews: {
    orderBy: { viewedAt: 'asc' },
    select: {
      viewedAt: true,
      card: { select: { position: true, question: true } },
    },
  },
  privacyRequests: {
    orderBy: { createdAt: 'asc' },
    select: { kind: true, status: true, createdAt: true, completedAt: true },
  },
} satisfies Prisma.UserSelect;
