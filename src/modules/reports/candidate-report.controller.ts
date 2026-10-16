import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { AppError, notFound } from '../../common/errors/app-error.js';
import { SessionsService } from '../interview/sessions.service.js';
import { fromCandidateSession } from './pdf/session-report.model.js';
import { SessionReportPdfService } from './pdf/session-report-pdf.service.js';

/** The candidate's own completed session as a PDF (FR-SCORE-04). Owner only, like GET /sessions/:id. */
@Controller('sessions')
export class CandidateReportController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly pdf: SessionReportPdfService,
  ) {}

  @Get(':id/report.pdf')
  @Header('Cache-Control', 'no-store')
  async report(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    // Loaded directly (not via `get`) so the role title comes with it; same 404s for others' sessions.
    const session = await this.sessions.loadOwned(user.id, id);
    if (session.status === 'in_progress') {
      throw new AppError(
        'session_in_progress',
        409,
        'Finish the session to download its report',
      );
    }
    if (session.status !== 'completed') throw notFound('Session not found');
    return this.pdf.download(
      fromCandidateSession(
        this.sessions.report(session),
        user.name,
        session.role.title,
      ),
    );
  }
}
