import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';
import type { AuditService } from '../../common/audit/audit.service.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { AppConfig } from '../../config/app-config.js';
import type { EmailService } from '../../jobs/email/email.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import {
  candidateBundle,
  candidatesCsv,
  scoresCsv,
  type CandidateExportSource,
} from './export-builders.js';
import { ExportService } from './export.service.js';

const NOW = new Date('2026-10-15T10:00:00Z');

const source: CandidateExportSource = {
  id: 'u1',
  email: 'asha@example.test',
  name: 'Asha',
  title: null,
  role: 'candidate',
  status: 'active',
  accessExpiresAt: null,
  firstLoginAt: NOW,
  lastActiveAt: NOW,
  createdAt: NOW,
  assignments: [
    {
      assignedAt: NOW,
      maxAttempts: 5,
      removedAt: null,
      role: { title: 'Analyst' },
    },
  ],
  sessions: [
    {
      id: 's1',
      number: 1,
      status: 'completed',
      mode: 'voice',
      startedAt: NOW,
      completedAt: NOW,
      durationS: 600,
      score: 72,
      band: 'nearly_ready',
      firstTryAvg: 60,
      retryAvg: 75,
      learningAvg: 80,
      skills: null,
      strengths: null,
      focusAreas: null,
      bandMessage: null,
      role: { title: 'Analyst' },
      attempts: [
        {
          id: 'a1',
          attemptNo: 1,
          mode: 'voice',
          status: 'done',
          transcript: 'I led a project',
          durationS: 40,
          wpm: 130,
          fillerCount: 1,
          pauseCount: 2,
          longestPauseS: 1.2,
          dimensionScores: { content: 70 },
          score: 70,
          learningScore: null,
          feedback: { worked: 'Clear' },
          feedbackText: 'Good',
          submittedAt: NOW,
          question: { text: 'Tell me about a project' },
          // Extra fields a broader query might return must not leak into the bundle.
          ...({
            audioKey: 'audio/s1/a1.webm',
            feedbackAudioKey: 'tts/f.mp3',
          } as object),
        },
      ],
    },
  ],
  consents: [{ kind: 'recording', textVersion: 'v1', givenAt: NOW }],
  activityEvents: [{ text: 'First login', at: NOW }],
  cardViews: [{ viewedAt: NOW, card: { position: 1, question: 'Q' } }],
  privacyRequests: [
    { kind: 'export', status: 'pending', createdAt: NOW, completedAt: null },
  ],
};

describe('export builders', () => {
  it('candidate bundle has transcripts and feedback but no audio', () => {
    const json = JSON.stringify(candidateBundle(source, NOW));
    expect(json).toContain('I led a project');
    expect(json).toContain('"feedbackText":"Good"');
    expect(json).toContain('"consents"');
    expect(json).not.toMatch(/audio/i);
  });

  it('workspace CSVs escape formulas and carry no transcripts', () => {
    const out = candidatesCsv([
      {
        id: 'u1',
        name: '=HYPERLINK("x")',
        email: 'a@x.test',
        status: 'active',
        roles: ['Analyst', 'PM'],
        invitedAt: NOW,
        firstLoginAt: null,
        lastActiveAt: null,
        accessExpiresAt: null,
      },
    ]);
    expect(out.split('\n')[0]).toBe(
      'candidate_id,name,email,status,roles,invited_at,first_login_at,last_active_at,access_expires_at',
    );
    expect(out).toContain(`"'=HYPERLINK(""x"")"`);
    expect(out).toContain('Analyst; PM');

    const scores = scoresCsv([
      {
        id: 'a1',
        sessionId: 's1',
        userId: 'u1',
        role: 'Analyst',
        question: 'Q1',
        attemptNo: 1,
        mode: 'voice',
        status: 'done',
        score: 70,
        learningScore: null,
        dimensionScores: { content: 70, delivery: 55 },
        wpm: 130,
        fillerCount: 1,
        pauseCount: 0,
        longestPauseS: null,
        durationS: 40,
        submittedAt: NOW,
        ...({ transcript: 'secret words' } as object),
      },
    ]);
    expect(scores).not.toContain('secret words');
    expect(scores.split('\n')[0]).not.toMatch(/transcript|audio/);
  });
});

function setup(job: Record<string, unknown> | null, user: unknown = source) {
  const prisma = {
    exportJob: {
      findUnique: vi.fn().mockResolvedValue(job),
      findFirst: vi.fn().mockResolvedValue(job),
      create: vi.fn().mockResolvedValue({ id: 'e1', createdAt: NOW }),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      findMany: vi.fn().mockResolvedValue([]),
    },
    session: { findMany: vi.fn().mockResolvedValue([]) },
    attempt: { findMany: vi.fn().mockResolvedValue([]) },
    privacyRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const settings = { update: vi.fn().mockResolvedValue({}) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const config = { env: { PUBLIC_API_URL: 'https://api.test/' } };
  const storage = {
    put: vi.fn().mockResolvedValue(undefined),
    signedUrl: vi.fn((key: string) => Promise.resolve(`https://s/${key}`)),
  };
  const queue = { add: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const service = new ExportService(
    prisma as unknown as PrismaService,
    settings as unknown as SettingsService,
    audit as unknown as AuditService,
    email as unknown as EmailService,
    config as unknown as AppConfig,
    storage as unknown as StorageAdapter,
    queue as unknown as QueueService,
  );
  return { service, prisma, settings, audit, email, storage, queue };
}

describe('ExportService', () => {
  it('starts a workspace export: job, queue, lastExportAt and the UI audit string', async () => {
    const { service, prisma, settings, audit, queue } = setup(null);
    await expect(
      service.startWorkspaceExport('sa1', '1.1.1.1'),
    ).resolves.toEqual({
      exportId: 'e1',
      lastExportAt: NOW.toISOString(),
    });
    expect(prisma.exportJob.create).toHaveBeenCalledWith({
      data: {
        kind: 'workspace_csv',
        requestedBy: 'sa1',
        subjectId: null,
        status: 'queued',
      },
    });
    expect(queue.add).toHaveBeenCalledWith(
      'export',
      { exportJobId: 'e1', privacyRequestId: undefined },
      expect.objectContaining({ jobId: 'export-e1' }),
    );
    expect(settings.update).toHaveBeenCalledWith({
      lastExportAt: NOW.toISOString(),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Exported all data',
        itemLabel: 'Workspace',
        entityId: 'e1',
      }),
    );
  });

  it('builds the candidate JSON, emails a 24 h link and completes the request', async () => {
    const { service, prisma, storage, email } = setup({
      id: 'e1',
      kind: 'candidate_json',
      status: 'queued',
      subjectId: 'u1',
      requestedBy: 'u1',
    });
    await service.run({ exportJobId: 'e1', privacyRequestId: 'p1' }, NOW);
    expect(storage.put).toHaveBeenCalledWith(
      'exports/e1.json',
      expect.any(Buffer),
      'application/json',
    );
    const body = (storage.put.mock.calls[0][1] as Buffer).toString();
    expect(body).not.toMatch(/audio/i);
    expect(storage.signedUrl).toHaveBeenCalledWith('exports/e1.json', 86400);
    expect(email.send).toHaveBeenCalledWith({
      template: 'export-ready',
      to: 'asha@example.test',
      vars: { link: 'https://s/exports/e1.json', expiresHours: 24 },
    });
    expect(prisma.exportJob.update).toHaveBeenLastCalledWith({
      where: { id: 'e1' },
      data: expect.objectContaining({
        status: 'done',
        fileKey: 'exports/e1.json',
      }),
    });
    expect(prisma.privacyRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', status: 'pending' },
      data: expect.objectContaining({ status: 'completed' }),
    });
  });

  it('fails a candidate export whose subject is hidden, without emailing', async () => {
    const { service, prisma, email } = setup(
      { id: 'e1', kind: 'candidate_json', status: 'queued', subjectId: 'u1' },
      null,
    );
    await service.run({ exportJobId: 'e1', privacyRequestId: 'p1' }, NOW);
    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.privacyRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.exportJob.update).toHaveBeenLastCalledWith({
      where: { id: 'e1' },
      data: expect.objectContaining({ status: 'failed' }),
    });
  });

  it('builds the workspace CSVs and emails the admin a link to the export', async () => {
    const { service, storage, email } = setup(
      { id: 'e1', kind: 'workspace_csv', status: 'queued', requestedBy: 'sa1' },
      { email: 'admin@x.test' },
    );
    await service.run({ exportJobId: 'e1' }, NOW);
    expect(storage.put.mock.calls.map((c) => c[0])).toEqual([
      'exports/e1/candidates.csv',
      'exports/e1/sessions.csv',
      'exports/e1/scores.csv',
    ]);
    expect(email.send).toHaveBeenCalledWith({
      template: 'export-ready',
      to: 'admin@x.test',
      vars: { link: 'https://api.test/api/admin/exports/e1', expiresHours: 24 },
    });
  });

  it('GET export: signed links while fresh, expired after 24 h, 404 for bad ids', async () => {
    const done = {
      id: 'e1',
      kind: 'workspace_csv',
      status: 'done',
      fileKey: 'exports/e1/',
      finishedAt: new Date(NOW.getTime() - 3600_000),
    };
    const { service } = setup(done);
    const view = await service.getWorkspaceExport(
      '6f1c2b8e-1d2a-4c3b-9a4e-5f6a7b8c9d0e',
      NOW,
    );
    expect(view.status).toBe('done');
    expect(view.files).toEqual([
      { name: 'candidates.csv', url: 'https://s/exports/e1/candidates.csv' },
      { name: 'sessions.csv', url: 'https://s/exports/e1/sessions.csv' },
      { name: 'scores.csv', url: 'https://s/exports/e1/scores.csv' },
    ]);
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    await expect(
      service.getWorkspaceExport('6f1c2b8e-1d2a-4c3b-9a4e-5f6a7b8c9d0e', later),
    ).resolves.toEqual({ status: 'expired', files: [] });
    await expect(service.getWorkspaceExport('nope', NOW)).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
  });
});
