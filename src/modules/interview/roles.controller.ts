import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { DashboardService } from './dashboard.service.js';
import {
  type RoleDetail,
  type RoleWithStatus,
  type StartSessionBody,
  type StartedSession,
  startSessionSchema,
} from './interview.schemas.js';
import { SessionsService } from './sessions.service.js';
import type { SessionSummary } from './types.js';

/** Candidate role endpoints (dashboard, role shell, start) and the admin preview session. */
@Controller()
export class RolesController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  @Get('roles')
  listRoles(@CurrentUser() user: AuthUser): Promise<RoleWithStatus[]> {
    return this.dashboard.listRoles(user);
  }

  @Get('roles/:roleId')
  getRole(
    @CurrentUser() user: AuthUser,
    @Param('roleId') roleId: string,
  ): Promise<RoleDetail> {
    return this.dashboard.getRole(user.id, roleId);
  }

  @Get('roles/:roleId/sessions')
  listRoleSessions(
    @CurrentUser() user: AuthUser,
    @Param('roleId') roleId: string,
  ): Promise<SessionSummary[]> {
    return this.dashboard.listRoleSessions(user.id, roleId);
  }

  @Post('roles/:roleId/sessions')
  @HttpCode(201)
  start(
    @CurrentUser() user: AuthUser,
    @Param('roleId') roleId: string,
    @Body(new ZodPipe(startSessionSchema)) body: StartSessionBody,
    @ClientIp() ip: string,
  ): Promise<StartedSession> {
    return this.sessions.start(user, roleId, body, ip);
  }

  /** FR-ROLE-07 test interview: a preview session owned by the admin, kept out of all stats. */
  @Roles('admin', 'super_admin')
  @Post('admin/roles/:id/preview-session')
  @HttpCode(201)
  async preview(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodPipe(startSessionSchema)) body: StartSessionBody,
    @ClientIp() ip: string,
  ): Promise<StartedSession> {
    const { session, role } = await this.sessions.startPreview(
      user,
      id,
      body,
      ip,
    );
    await this.audit.record({
      actorId: user.id,
      action: 'Started test interview',
      entity: 'job_role',
      entityId: role.id,
      itemLabel: role.title,
      after: { sessionId: session.id },
      ip,
    });
    return session;
  }
}
