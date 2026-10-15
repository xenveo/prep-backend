import { Inject, Injectable } from '@nestjs/common';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import type { EmailJob } from './templates/templates.js';

export type {
  EmailJob,
  EmailTemplate,
  EmailVars,
} from './templates/templates.js';

const ATTEMPTS = 3;
const BACKOFF_MS = 2000;

/** Producers call `send`; EmailProcessor renders and delivers on the `email` queue. */
@Injectable()
export class EmailService {
  constructor(@Inject(QUEUE_SERVICE) private readonly queue: QueueService) {}

  async send(job: EmailJob): Promise<void> {
    await this.queue.add('email', job, {
      attempts: ATTEMPTS,
      backoffMs: BACKOFF_MS,
    });
  }
}
