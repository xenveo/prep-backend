import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { RemindersService, type ReminderInput } from './reminders.service.js';

export const remindCandidatesSchema = z
  .object({
    candidateIds: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .transform((ids) => [...new Set(ids)]),
    dryRun: z.boolean().default(true),
  })
  .strict();

@Roles('admin', 'super_admin')
@Controller('admin/candidates')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Post('remind')
  @HttpCode(200)
  remind(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodPipe(remindCandidatesSchema)) body: ReminderInput,
    @ClientIp() ip: string,
  ) {
    return this.reminders.remind(admin, body, ip);
  }
}
