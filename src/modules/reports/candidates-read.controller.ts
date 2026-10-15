import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { CandidatesReadService } from './candidates-read.service.js';
import { attachment } from './csv.js';
import {
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
  ) {}

  @Get()
  list(
    @Query(new ZodPipe(candidateQuerySchema)) query: CandidateQuery,
  ): Promise<CandidateList> {
    return this.candidates.list(query);
  }

  /** Registered before `:id` so "export.csv" is not read as an id. */
  @Get('export.csv')
  async exportCsv(
    @Query(new ZodPipe(candidateExportSchema)) query: { ids?: string[] },
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.candidates.exportCsv(query.ids ?? []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', attachment('candidates.csv'));
    return csv;
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
}
