import type { QueueService } from '../../common/queue/queue.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TtsCacheService } from './tts-cache.service.js';
import {
  enqueueTtsPregen,
  TtsPregenProcessor,
} from './tts-pregen.processor.js';

function setup(found: unknown) {
  const queue = {
    add: vi.fn().mockResolvedValue({ jobId: 'tts-q1' }),
    process: vi.fn(),
  };
  const prisma = {
    question: {
      findUnique: vi.fn().mockResolvedValue(found),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const tts = {
    getOrCreate: vi.fn().mockResolvedValue({ key: 'tts/k.mp3', durationS: 1 }),
  };
  const processor = new TtsPregenProcessor(
    queue as unknown as QueueService,
    prisma as unknown as PrismaService,
    tts as unknown as TtsCacheService,
  );
  return { processor, queue, prisma, tts };
}

describe('TtsPregenProcessor', () => {
  it('enqueues with a colon-free, per-question job id', async () => {
    const { queue } = setup(null);
    await enqueueTtsPregen(queue as unknown as QueueService, 'q1');
    expect(queue.add).toHaveBeenCalledWith(
      'tts-pregen',
      { questionId: 'q1' },
      expect.objectContaining({ jobId: 'tts-q1' }),
    );
  });

  it('registers its processor on init', () => {
    const { processor, queue } = setup(null);
    processor.onModuleInit();
    expect(queue.process).toHaveBeenCalledWith(
      'tts-pregen',
      expect.any(Function),
    );
  });

  it('stores the audio key of an approved question', async () => {
    const { processor, prisma, tts } = setup({
      text: 'Hello',
      status: 'approved',
    });
    await processor.handle({ questionId: 'q1' });
    expect(tts.getOrCreate).toHaveBeenCalledWith('Hello');
    expect(prisma.question.updateMany).toHaveBeenCalledWith({
      where: { id: 'q1', text: 'Hello' },
      data: { audioKey: 'tts/k.mp3' },
    });
  });

  it('skips missing or unapproved questions', async () => {
    const { processor, tts } = setup({ text: 'x', status: 'ai_draft' });
    await processor.handle({ questionId: 'q1' });
    expect(tts.getOrCreate).not.toHaveBeenCalled();
  });
});
