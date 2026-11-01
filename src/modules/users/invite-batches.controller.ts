import { Controller, Get, Param } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { InviteBatchesService } from './invite-batches.service.js';
import { idSchema } from './users.schemas.js';

@Roles('admin', 'super_admin')
@Controller('admin/invites/batches')
export class InviteBatchesController {
  constructor(private readonly batches: InviteBatchesService) {}

  @Get(':id')
  status(@Param('id', new ZodPipe(idSchema)) id: string) {
    return this.batches.status(id);
  }
}
