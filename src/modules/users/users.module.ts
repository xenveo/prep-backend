import { Module } from '@nestjs/common';
import { AdminsController } from './admins.controller.js';
import { AdminsService } from './admins.service.js';
import { AssignmentsService } from './assignments.service.js';
import { CandidatesController } from './candidates.controller.js';
import { InviteBatchesController } from './invite-batches.controller.js';
import { InviteBatchesService } from './invite-batches.service.js';
import { InvitesService } from './invites.service.js';
import { SavedFiltersService } from './saved-filters.service.js';
import { UsersService } from './users.service.js';

/** AuditService, EVENT_BUS, EmailService, SettingsService and ActivityService come from global modules. */
@Module({
  controllers: [
    CandidatesController,
    AdminsController,
    InviteBatchesController,
  ],
  providers: [
    AssignmentsService,
    UsersService,
    InvitesService,
    InviteBatchesService,
    AdminsService,
    SavedFiltersService,
  ],
  exports: [AssignmentsService, UsersService],
})
export class UsersModule {}
