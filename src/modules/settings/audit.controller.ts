import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator.js';
import type { Page } from '../../common/pagination/pagination.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import {
  AuditQueryService,
  auditQuerySchema,
  type AuditEventView,
  type AuditQuery,
} from './audit-query.service.js';

@Controller('admin/audit')
@Roles('admin', 'super_admin')
export class AuditController {
  constructor(private readonly service: AuditQueryService) {}

  @Get()
  list(
    @Query(new ZodPipe(auditQuerySchema)) query: AuditQuery,
  ): Promise<Page<AuditEventView>> {
    return this.service.list(query);
  }

  @Get('actions')
  actions(): Promise<string[]> {
    return this.service.actions();
  }
}
