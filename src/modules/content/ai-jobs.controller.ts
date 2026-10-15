import { Controller, Get, Inject, Param } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { notFound } from '../../common/errors/app-error.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import type { AiDraftJob, AiDraftResult } from './ai-draft.processor.js';

const jobIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
class JobIdParamPipe {
  transform(value: unknown): string {
    const parsed = jobIdSchema.safeParse(value);
    if (!parsed.success) throw notFound();
    return parsed.data;
  }
}

export type AiJobResponse =
  | { status: 'queued' | 'running' }
  | { status: 'done'; result: AiDraftResult }
  | { status: 'failed'; code: 'ai_unavailable' };

/** Only the submitting admin can read a draft job, including when they are a super admin. */
@Roles('admin', 'super_admin')
@Controller('admin/ai-jobs')
export class AiJobsController {
  constructor(@Inject(QUEUE_SERVICE) private readonly queue: QueueService) {}

  @Get(':id')
  async get(
    @Param('id', new JobIdParamPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AiJobResponse> {
    const job = await this.queue.getJob<AiDraftJob, AiDraftResult>(
      'ai-draft',
      id,
    );
    if (!job || job.data.adminId !== user.id) throw notFound();
    if (job.status === 'done') return { status: 'done', result: job.result };
    if (job.status === 'failed')
      return { status: 'failed', code: 'ai_unavailable' };
    return { status: job.status };
  }
}
