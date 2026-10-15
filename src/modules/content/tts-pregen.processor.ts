import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TtsCacheService } from './tts-cache.service.js';

export type TtsPregenJob = { questionId: string };

const ATTEMPTS = 3;
const BACKOFF_MS = 2000;

/** Queues question TTS pre-generation (plan §8 `tts-pregen`). Deduplicated per question. */
export function enqueueTtsPregen(
  queue: QueueService,
  questionId: string,
): Promise<{ jobId: string }> {
  return queue.add<TtsPregenJob>(
    'tts-pregen',
    { questionId },
    { jobId: `tts-${questionId}`, attempts: ATTEMPTS, backoffMs: BACKOFF_MS },
  );
}

/** Renders an approved question's text to speech and stores the key on `Question.audioKey` (NFR-01). */
@Injectable()
export class TtsPregenProcessor implements OnModuleInit {
  private readonly logger = new Logger(TtsPregenProcessor.name);

  constructor(
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    private readonly prisma: PrismaService,
    private readonly tts: TtsCacheService,
  ) {}

  onModuleInit(): void {
    this.queue.process<TtsPregenJob, void>('tts-pregen', (job) =>
      this.handle(job),
    );
  }

  async handle({ questionId }: TtsPregenJob): Promise<void> {
    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: { text: true, status: true },
    });
    if (!question || question.status !== 'approved') return;
    const { key } = await this.tts.getOrCreate(question.text);
    // Only store the key if the text hasn't changed while we were rendering it.
    await this.prisma.question.updateMany({
      where: { id: questionId, text: question.text },
      data: { audioKey: key },
    });
    this.logger.log(`Question ${questionId} audio ready`);
  }
}
