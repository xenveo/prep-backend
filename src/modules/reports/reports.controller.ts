import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { attachment } from './csv.js';
import { reportQuerySchema, type ReportQuery } from './reports.schemas.js';
import { ReportsService } from './reports.service.js';
import type { Report } from './reports.types.js';

/** Role reports (admin UI services/reports.ts; FR-REP-01, 03, 04). */
@Roles('admin', 'super_admin')
@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  report(
    @Query(new ZodPipe(reportQuerySchema)) query: ReportQuery,
  ): Promise<Report> {
    return this.reports.report(query);
  }

  @Get('export.csv')
  async exportCsv(
    @Query(new ZodPipe(reportQuerySchema)) query: ReportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { filename, csv } = await this.reports.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', attachment(filename));
    return csv;
  }
}
