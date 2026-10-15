import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { FlagsService } from './flags.service.js';
import {
  flagInputSchema,
  type FlagInput,
  resolveFlagSchema,
  type ResolveFlagInput,
  UuidParamPipe,
} from './reports.schemas.js';
import type { EvaluationFlagView } from './reports.types.js';

const uuid = new UuidParamPipe();

/** Evaluation flags (admin UI services/sessions.ts; FR-REP-05). */
@Roles('admin', 'super_admin')
@Controller('admin')
export class FlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Get('sessions/:sid/flags')
  list(@Param('sid', uuid) sid: string): Promise<EvaluationFlagView[]> {
    return this.flags.list(sid);
  }

  @Post('sessions/:sid/flags')
  submit(
    @Param('sid', uuid) sid: string,
    @Body(new ZodPipe(flagInputSchema)) body: FlagInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<EvaluationFlagView> {
    return this.flags.submit(sid, body, { id: user.id, ip });
  }

  @Patch('flags/:id')
  resolve(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(resolveFlagSchema)) body: ResolveFlagInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<EvaluationFlagView> {
    return this.flags.resolve(id, body, { id: user.id, ip });
  }
}
