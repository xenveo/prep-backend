import { Body, Controller, Get, Put } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import {
  AiConfigService,
  aiConfigUpdateSchema,
  type AiConfig,
  type AiConfigUpdate,
  type PromptRoleConfig,
} from './ai-config.service.js';

@Controller('admin/ai-config')
@Roles('super_admin')
export class AiConfigController {
  constructor(private readonly service: AiConfigService) {}

  @Get()
  get(): Promise<AiConfig> {
    return this.service.get();
  }

  @Put()
  update(
    @Body(new ZodPipe(aiConfigUpdateSchema)) body: AiConfigUpdate,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<PromptRoleConfig> {
    return this.service.update(body, user.id, ip);
  }
}
