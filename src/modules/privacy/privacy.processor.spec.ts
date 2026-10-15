import type { QueueService } from '../../common/queue/queue.types.js';
import type { ErasureService } from './erasure.service.js';
import type { ExportService } from './export.service.js';
import { PrivacyProcessor, purgeJobId } from './privacy.processor.js';
import type { RetentionService } from './retention.service.js';

describe('PrivacyProcessor', () => {
  it('purge job id is the India calendar day, without colons', () => {
    // 02:00 IST on 15 Oct is 20:30 UTC on 14 Oct.
    expect(purgeJobId(new Date('2026-10-14T20:30:00Z'))).toBe('purge-20261015');
  });

  it('registers every privacy queue and enqueues the nightly purge once per day', async () => {
    const queue = {
      process: vi.fn(),
      add: vi.fn().mockResolvedValue({ jobId: 'purge-20261015' }),
    };
    const processor = new PrivacyProcessor(
      queue as unknown as QueueService,
      {} as RetentionService,
      {} as ExportService,
      {} as ErasureService,
    );
    processor.onModuleInit();
    expect(queue.process.mock.calls.map((c) => c[0]).sort()).toEqual([
      'erasure-hide',
      'erasure-purge',
      'export',
      'purge',
      'retention-update',
    ]);
    await processor.schedulePurge(new Date('2026-10-14T20:30:00Z'));
    expect(queue.add).toHaveBeenCalledWith(
      'purge',
      {},
      { jobId: 'purge-20261015' },
    );
  });
});
