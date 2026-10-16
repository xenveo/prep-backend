import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import {
  AiUsageService,
  aiUsageQuerySchema,
  type AiUsage,
  type AiUsageQuery,
} from './ai-usage.service.js';

@Controller('admin/ai-usage')
@Roles('super_admin')
export class AiUsageController {
  constructor(private readonly service: AiUsageService) {}

  @Get()
  get(
    @Query(new ZodPipe(aiUsageQuerySchema)) query: AiUsageQuery,
  ): Promise<AiUsage> {
    return this.service.get(query);
  }
}
