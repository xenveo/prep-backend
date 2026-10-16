import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { InvitesService } from './invites.service.js';
import { SavedFiltersService } from './saved-filters.service.js';
import {
  type AssignRolesBody,
  assignRolesSchema,
  idSchema,
  type IdsBody,
  idsSchema,
  type InviteBatchBody,
  type InviteBatchResult,
  inviteBatchSchema,
  type InviteContext,
  type InviteRow,
  type InviteSummary,
  type ResendInvitesBody,
  resendInvitesSchema,
  type SavedFilter,
  type SaveFilterBody,
  saveFilterSchema,
  type UpdateAssignmentBody,
  updateAssignmentSchema,
  type UpdateCandidateBody,
  updateCandidateSchema,
  type ValidateInvitesBody,
  validateInvitesSchema,
} from './users.schemas.js';
import { UsersService } from './users.service.js';

const idPipe = new ZodPipe(idSchema);

/** Admin user management (spec "Me and candidates"). The candidate list/detail/export live in reports. */
@Roles('admin', 'super_admin')
@Controller('admin')
export class CandidatesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly users: UsersService,
    private readonly savedFilters: SavedFiltersService,
  ) {}

  @Get('invites/context')
  inviteContext(): Promise<InviteContext> {
    return this.invites.getContext();
  }

  @Post('invites/validate')
  @HttpCode(200)
  validateInvites(
    @Body(new ZodPipe(validateInvitesSchema)) body: ValidateInvitesBody,
  ): Promise<{ rows: InviteRow[]; summary: InviteSummary }> {
    return this.invites.validate(body.rows);
  }

  @Post('invites')
  @HttpCode(200)
  invite(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodPipe(inviteBatchSchema)) body: InviteBatchBody,
    @ClientIp() ip: string,
  ): Promise<InviteBatchResult> {
    return this.invites.invite(admin, body, ip);
  }

  @Post('invites/resend')
  @HttpCode(200)
  resendInvites(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodPipe(resendInvitesSchema)) body: ResendInvitesBody,
    @ClientIp() ip: string,
  ): Promise<{ resent: number; skipped: number }> {
    return this.invites.resend(admin, body.candidateIds, ip);
  }

  @Post('candidates/:id/revoke-invite')
  @HttpCode(204)
  revokeInvite(
    @CurrentUser() admin: AuthUser,
    @Param('id', idPipe) id: string,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.users.revokeInvite(admin, id, ip);
  }

  @Post('candidates/deactivate')
  @HttpCode(200)
  deactivate(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodPipe(idsSchema)) body: IdsBody,
    @ClientIp() ip: string,
  ): Promise<{ deactivated: number; skipped: number }> {
    return this.users.deactivate(admin, body.ids, ip);
  }

  @Post('candidates/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodPipe(idsSchema)) body: IdsBody,
    @ClientIp() ip: string,
  ): Promise<{ reactivated: number }> {
    return this.users.reactivate(admin, body.ids, ip);
  }

  @Post('candidates/assign-roles')
  @HttpCode(200)
  assignRoles(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodPipe(assignRolesSchema)) body: AssignRolesBody,
    @ClientIp() ip: string,
  ): Promise<{ added: number }> {
    return this.users.assignRoles(admin, body.ids, body.roleIds, ip);
  }

  @Patch('candidates/:id')
  @HttpCode(204)
  updateCandidate(
    @CurrentUser() admin: AuthUser,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(updateCandidateSchema)) body: UpdateCandidateBody,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.users.updateCandidate(admin, id, body, ip);
  }

  @Delete('candidates/:id/roles/:roleId')
  @HttpCode(204)
  removeRole(
    @CurrentUser() admin: AuthUser,
    @Param('id', idPipe) id: string,
    @Param('roleId', idPipe) roleId: string,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.users.removeRole(admin, id, roleId, ip);
  }

  @Patch('candidates/:id/roles/:roleId')
  @HttpCode(204)
  updateAssignment(
    @CurrentUser() admin: AuthUser,
    @Param('id', idPipe) id: string,
    @Param('roleId', idPipe) roleId: string,
    @Body(new ZodPipe(updateAssignmentSchema)) body: UpdateAssignmentBody,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.users.updateAssignment(admin, id, roleId, body.maxSessions, ip);
  }

  @Get('saved-filters')
  listSavedFilters(@CurrentUser() admin: AuthUser): Promise<SavedFilter[]> {
    return this.savedFilters.list(admin.id);
  }

  @Post('saved-filters')
  @HttpCode(201)
  saveFilter(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodPipe(saveFilterSchema)) body: SaveFilterBody,
    @ClientIp() ip: string,
  ): Promise<SavedFilter> {
    return this.savedFilters.create(admin, body, ip);
  }

  @Delete('saved-filters/:id')
  @HttpCode(204)
  deleteSavedFilter(
    @CurrentUser() admin: AuthUser,
    @Param('id', idPipe) id: string,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.savedFilters.remove(admin, id, ip);
  }
}
