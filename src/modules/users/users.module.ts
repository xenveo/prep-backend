import { Module } from '@nestjs/common';
import { AdminsController } from './admins.controller.js';
import { AdminsService } from './admins.service.js';
import { AssignmentsService } from './assignments.service.js';
import { CandidatesController } from './candidates.controller.js';
import { InvitesService } from './invites.service.js';
import { SavedFiltersService } from './saved-filters.service.js';
import { UsersService } from './users.service.js';

/** AuditService, EVENT_BUS, EmailService, SettingsService and ActivityService come from global modules. */
@Module({
  controllers: [CandidatesController, AdminsController],
  providers: [
    AssignmentsService,
    UsersService,
    InvitesService,
    AdminsService,
    SavedFiltersService,
  ],
  exports: [AssignmentsService, UsersService],
})
export class UsersModule {}
