import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import {
  paginationQuerySchema,
  type Page,
  type PaginationQuery,
} from '../../common/pagination/pagination.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { ExportService, type WorkspaceExportView } from './export.service.js';
import { PrivacyService, type PrivacyRequestView } from './privacy.service.js';

/** Super admin data exports and privacy requests (spec "Workspace settings, admins, audit"). */
@Controller('admin')
@Roles('super_admin')
export class PrivacyAdminController {
  constructor(
    private readonly exports: ExportService,
    private readonly privacy: PrivacyService,
  ) {}

  @Post('exports')
  startExport(
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<{ exportId: string; lastExportAt: string }> {
    return this.exports.startWorkspaceExport(user.id, ip);
  }

  @Get('exports/:id')
  getExport(@Param('id') id: string): Promise<WorkspaceExportView> {
    return this.exports.getWorkspaceExport(id);
  }

  @Get('privacy/requests')
  listRequests(
    @Query(new ZodPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<PrivacyRequestView>> {
    return this.privacy.list(query);
  }

  @Post('privacy/requests/:id/complete')
  @HttpCode(200)
  complete(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<PrivacyRequestView> {
    return this.privacy.complete(id, user.id, ip);
  }
}
