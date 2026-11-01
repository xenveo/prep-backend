import { Controller, Get, Header, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { ExecutiveInsightsService } from './executive-insights.service.js';
import {
  executiveCandidatesQuerySchema,
  executiveQuerySchema,
  type ExecutiveCandidatesQuery,
  type ExecutiveQuery,
} from './executive.schemas.js';
import { ExecutiveService } from './executive.service.js';

/** Executive read models: FR-REP-01, FR-REP-03; all admins are recruiters. */
@Roles('admin', 'super_admin')
@Controller('admin/reports/executive')
export class ExecutiveController {
  constructor(
    private readonly executive: ExecutiveService,
    private readonly insights: ExecutiveInsightsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  overview(@Query(new ZodPipe(executiveQuerySchema)) query: ExecutiveQuery) {
    return this.executive.overview(query);
  }

  @Get('candidates')
  @Header('Cache-Control', 'no-store')
  candidates(
    @Query(new ZodPipe(executiveCandidatesQuerySchema))
    query: ExecutiveCandidatesQuery,
  ) {
    return this.executive.candidates(query);
  }

  @Get('insights')
  @Header('Cache-Control', 'no-store')
  supporting(@Query(new ZodPipe(executiveQuerySchema)) query: ExecutiveQuery) {
    return this.insights.report(query);
  }
}
