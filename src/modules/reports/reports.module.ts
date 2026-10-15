import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { CandidatesReadController } from './candidates-read.controller.js';
import { CandidatesReadService } from './candidates-read.service.js';
import { FlagsController } from './flags.controller.js';
import { FlagsService } from './flags.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { SessionReviewService } from './session-review.service.js';

/** Admin read models: candidate list/detail/CSV, session review, flags, role reports (FR-REP-01..05). */
@Module({
  imports: [UsersModule],
  controllers: [CandidatesReadController, FlagsController, ReportsController],
  providers: [
    CandidatesReadService,
    SessionReviewService,
    FlagsService,
    ReportsService,
  ],
})
export class ReportsModule {}
