import type { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from './activity.service.js';

describe('ActivityService', () => {
  const prisma = { activityEvent: { create: vi.fn(), findMany: vi.fn() } };
  const service = new ActivityService(prisma as unknown as PrismaService);

  it('records an event with the given time', async () => {
    const at = new Date('2026-01-02T03:04:05Z');
    await service.record('u1', 'First login', at);
    expect(prisma.activityEvent.create).toHaveBeenCalledWith({
      data: { userId: 'u1', text: 'First login', at },
    });
  });

  it('lists newest first with ISO times', async () => {
    prisma.activityEvent.findMany.mockResolvedValue([
      { text: 'b', at: new Date('2026-01-02T00:00:00Z') },
    ]);
    await expect(service.list('u1')).resolves.toEqual([
      { text: 'b', at: '2026-01-02T00:00:00.000Z' },
    ]);
    expect(prisma.activityEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
        orderBy: { at: 'desc' },
      }),
    );
  });
});
