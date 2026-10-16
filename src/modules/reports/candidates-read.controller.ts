import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { CandidatesReadService } from './candidates-read.service.js';
import { attachment } from './csv.js';
import { fromSessionReview } from './pdf/session-report.model.js';
import { SessionReportPdfService } from './pdf/session-report-pdf.service.js';
import {
  candidateExportBodySchema,
  type CandidateExportBody,
  candidateExportSchema,
  candidateQuerySchema,
  type CandidateQuery,
  UuidParamPipe,
} from './reports.schemas.js';
import type {
  CandidateDetail,
  CandidateList,
  SessionReview,
} from './reports.types.js';
import { SessionReviewService } from './session-review.service.js';

const uuid = new UuidParamPipe();

/** Candidate read models (admin UI services/candidates.ts, sessions.ts `getSessionReview`). */
@Roles('admin', 'super_admin')
@Controller('admin/candidates')
export class CandidatesReadController {
  constructor(
    private readonly candidates: CandidatesReadService,
    private readonly reviews: SessionReviewService,
    private readonly pdf: SessionReportPdfService,
  ) {}

  @Get()
  list(
    @Query(new ZodPipe(candidateQuerySchema)) query: CandidateQuery,
  ): Promise<CandidateList> {
    return this.candidates.list(query);
  }

  /** Registered before `:id` so "export.csv" is not read as an id. */
  @Get('export.csv')
  exportCsv(
    @Query(new ZodPipe(candidateExportSchema)) query: { ids?: string[] },
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    return this.sendCsv(query.ids ?? [], res);
  }

  /** Same export for selections too large for a query string. */
  @Post('export.csv')
  @HttpCode(200)
  exportCsvPost(
    @Body(new ZodPipe(candidateExportBodySchema)) body: CandidateExportBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    return this.sendCsv(body.ids, res);
  }

  @Get(':id')
  detail(@Param('id', uuid) id: string): Promise<CandidateDetail> {
    return this.candidates.detail(id);
  }

  @Get(':cid/sessions/:sid')
  review(
    @Param('cid', uuid) cid: string,
    @Param('sid', uuid) sid: string,
  ): Promise<SessionReview> {
    return this.reviews.review(cid, sid);
  }

  /** The session review as a PDF (FR-SCORE-04). A read, so not audited (like the CSV export). */
  @Get(':cid/sessions/:sid/report.pdf')
  @Header('Cache-Control', 'no-store')
  async reviewPdf(
    @Param('cid', uuid) cid: string,
    @Param('sid', uuid) sid: string,
  ): Promise<StreamableFile> {
    const review = await this.reviews.review(cid, sid);
    return this.pdf.download(fromSessionReview(review));
  }

  private async sendCsv(ids: string[], res: Response): Promise<string> {
    const csv = await this.candidates.exportCsv(ids);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', attachment('candidates.csv'));
    return csv;
  }
}
