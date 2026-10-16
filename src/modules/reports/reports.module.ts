import { Module } from '@nestjs/common';
import { InterviewModule } from '../interview/interview.module.js';
import { UsersModule } from '../users/users.module.js';
import { CandidateReportController } from './candidate-report.controller.js';
import { CandidatesReadController } from './candidates-read.controller.js';
import { CandidatesReadService } from './candidates-read.service.js';
import { FlagsController } from './flags.controller.js';
import { FlagsService } from './flags.service.js';
import { SessionReportPdfService } from './pdf/session-report-pdf.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { SessionReviewService } from './session-review.service.js';

/**
 * Admin read models: candidate list/detail/CSV, session review, flags, role reports (FR-REP-01..05),
 * and the PDF session report for candidates and admins (FR-SCORE-04).
 */
@Module({
  imports: [UsersModule, InterviewModule],
  controllers: [
    CandidatesReadController,
    CandidateReportController,
    FlagsController,
    ReportsController,
  ],
  providers: [
    CandidatesReadService,
    SessionReviewService,
    SessionReportPdfService,
    FlagsService,
    ReportsService,
  ],
})
export class ReportsModule {}
