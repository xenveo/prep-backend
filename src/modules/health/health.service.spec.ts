import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  beforeEach(() =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => vi.restoreAllMocks());

  it('reports db ok', async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    await expect(
      new HealthService(prisma as unknown as PrismaService).check(),
    ).resolves.toEqual({ status: 'ok', db: 'ok' });
  });

  it('reports db error without throwing', async () => {
    const prisma = { $queryRaw: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(
      new HealthService(prisma as unknown as PrismaService).check(),
    ).resolves.toEqual({
      status: 'ok',
      db: 'error',
    });
  });
});
