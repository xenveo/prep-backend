import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SETTINGS_FIELD_AUDIT } from '../../modules/settings/settings.schema.js';
import { AuditService } from './audit.service.js';

function mockPrisma() {
  return {
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(3),
  };
}

describe('AuditService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let audit: AuditService;
  const base = {
    actorId: 'admin-1',
    entity: 'job_role',
    entityId: 'role-1',
    ip: '1.2.3.4',
  };

  beforeEach(() => {
    prisma = mockPrisma();
    audit = new AuditService(prisma as unknown as PrismaService);
  });

  it('records a row with null snapshots when none are given', async () => {
    await audit.record({
      ...base,
      action: 'Approved role',
      itemLabel: 'Store Manager',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'Approved role',
        itemLabel: 'Store Manager',
        entityId: 'role-1',
        before: Prisma.DbNull,
        after: Prisma.DbNull,
      }),
    });
  });

  it('writes through a transaction client when given one', async () => {
    const tx = mockPrisma();
    await audit.record(
      { ...base, action: 'Archived role', itemLabel: 'X' },
      tx as never,
    );
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  describe('recordMerged', () => {
    const input = {
      ...base,
      action: 'Edited role',
      itemLabel: 'Store Manager',
      before: { a: 1 },
      after: { a: 2 },
    };

    it('inserts when there is no recent matching row', async () => {
      await audit.recordMerged(input);
      expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            actorId: 'admin-1',
            action: 'Edited role',
            entity: 'job_role',
            entityId: 'role-1',
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalled();
      expect(prisma.auditLog.update).not.toHaveBeenCalled();
    });

    it('updates after and time of a recent row, keeping its before', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
      prisma.auditLog.findFirst.mockResolvedValue({ id: 'aud-1' });
      await audit.recordMerged({ ...input, after: { a: 3 } }, 10);
      const where = prisma.auditLog.findFirst.mock.calls[0][0].where;
      expect(where.at.gte).toEqual(new Date('2026-01-01T09:50:00Z'));
      const call = prisma.auditLog.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'aud-1' });
      expect(call.data).toMatchObject({
        after: { a: 3 },
        at: new Date('2026-01-01T10:00:00Z'),
      });
      expect(call.data).not.toHaveProperty('before');
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('recordFieldChanges', () => {
    const before = {
      voice: 'Calm, mid-pitch',
      feedbackLength: 'standard',
      audioRetentionDays: 90,
      transcriptRetention: '12m',
      candidatesCanDeleteData: true,
      senderName: 'PrepPilot',
      replyTo: '[reply-to@company.com]',
    } as never;

    it('writes one row per changed field with the admin UI action and "old → new" label', async () => {
      const n = await audit.recordFieldChanges(
        {
          actorId: 'admin-1',
          entity: 'workspace_settings',
          entityId: null,
          ip: null,
        },
        SETTINGS_FIELD_AUDIT,
        before,
        {
          audioRetentionDays: 30,
          transcriptRetention: '6m',
          candidatesCanDeleteData: false,
          voice: 'Calm, mid-pitch',
        } as never,
      );
      expect(n).toBe(3);
      const rows = prisma.auditLog.createMany.mock.calls[0][0].data;
      expect(
        rows.map((r: { action: string; itemLabel: string }) => [
          r.action,
          r.itemLabel,
        ]),
      ).toEqual([
        ['Changed audio retention', '90 days → 30 days'],
        ['Changed transcript retention', '12 months → 6 months'],
        ['Changed candidate data deletion', 'On → Off'],
      ]);
      expect(rows[0]).toMatchObject({
        before: { audioRetentionDays: 90 },
        after: { audioRetentionDays: 30 },
      });
    });

    it('writes nothing when nothing changed', async () => {
      const n = await audit.recordFieldChanges(
        { actorId: 'admin-1', entity: 'workspace_settings' },
        SETTINGS_FIELD_AUDIT,
        before,
        { senderName: 'PrepPilot' } as never,
      );
      expect(n).toBe(0);
      expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
    });
  });

  it('redactSubject runs a parameterised update', async () => {
    await expect(audit.redactSubject('user-1')).resolves.toBe(3);
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('UPDATE "audit_logs"');
    expect(values).toEqual(['Deleted candidate', 'user-1', 'user-1', 'user-1']);
  });
});
