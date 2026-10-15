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
import { AdminsService } from './admins.service.js';
import {
  type AdminView,
  type ChangeAdminAccessBody,
  changeAdminAccessSchema,
  idSchema,
  type InviteAdminBody,
  inviteAdminSchema,
} from './users.schemas.js';

const idPipe = new ZodPipe(idSchema);

/** Admin accounts. Any admin can list them; only a Super admin can change them. */
@Roles('admin', 'super_admin')
@Controller('admin/admins')
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  list(): Promise<AdminView[]> {
    return this.admins.list();
  }

  @Roles('super_admin')
  @Post()
  @HttpCode(201)
  invite(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodPipe(inviteAdminSchema)) body: InviteAdminBody,
    @ClientIp() ip: string,
  ): Promise<AdminView> {
    return this.admins.invite(actor, body, ip);
  }

  @Roles('super_admin')
  @Post(':id/resend')
  @HttpCode(204)
  resend(
    @CurrentUser() actor: AuthUser,
    @Param('id', idPipe) id: string,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.admins.resend(actor, id, ip);
  }

  @Roles('super_admin')
  @Patch(':id')
  changeAccess(
    @CurrentUser() actor: AuthUser,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(changeAdminAccessSchema)) body: ChangeAdminAccessBody,
    @ClientIp() ip: string,
  ): Promise<AdminView> {
    return this.admins.changeAccess(actor, id, body.access, ip);
  }

  @Roles('super_admin')
  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() actor: AuthUser,
    @Param('id', idPipe) id: string,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.admins.remove(actor, id, ip);
  }
}
