import { Injectable } from '@nestjs/common';
import { notFound } from '../../common/errors/app-error.js';
import type { Band } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DIMENSIONS, type DimensionScores } from '../interview/types.js';
import { toCsv } from './csv.js';
import {
  countBands,
  emptyBands,
  needsAttention,
  pickHardest,
  reportChange,
  reportCsvFilename,
  reportCsvRows,
  reportRange,
  roundedMean,
  weakestDimension,
  weakestNote,
} from './report-rules.js';
import {
  cohortRows,
  dimensionAverages,
  questionAggregates,
  type ReportScope,
} from './report.sql.js';
import type { ReportQuery } from './reports.schemas.js';
import type { Report } from './reports.types.js';

/**
 * Role reports (FR-REP-01, FR-REP-03). Baseline = each candidate's first session ever; latest =
 * their last session in scope. Previews and erased candidates never count.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(q: ReportQuery, now = new Date()): Promise<Report> {
    const role = await this.prisma.jobRole.findUnique({
      where: { id: q.roleId },
      select: { id: true, title: true, status: true },
    });
    if (!role) throw notFound('Role not found');

    const range = reportRange(q, now);
    const scope: ReportScope = {
      roleId: role.id,
      basis: q.dateBasis,
      start: range.start,
      end: range.end,
    };
    const base = {
      roleId: role.id,
      roleTitle: role.title,
      range: { from: range.from, to: range.to, label: range.label },
      illustrative: [],
    };

    const cohort = await cohortRows(this.prisma, scope);
    const invited = cohort.length;
    if (role.status !== 'approved')
      return {
        ...base,
        hasData: false,
        stats: {
          invited,
          active: 0,
          completedSession: 0,
          avgBaseline: null,
          avgLatest: null,
          change: null,
        },
        bandsLatest: emptyBands(),
        bandsBaseline: emptyBands(),
        hardestQuestions: [],
        dimensionAverages: null,
        weakest: null,
        weakestNote: null,
        needsAttention: [],
      };

    const [questions, dims] = await Promise.all([
      questionAggregates(this.prisma, scope),
      dimensionAverages(this.prisma, scope),
    ]);

    const practised = cohort.filter((c) => c.sessions_in_scope > 0);
    const baselines = practised.map((c) => c.baseline_score!);
    const latests = practised.map((c) => c.latest_score!);
    const avgBaseline = roundedMean(baselines);
    const avgLatest = roundedMean(latests);
    const dimensionAvgs: DimensionScores | null =
      dims.content === null
        ? null
        : (Object.fromEntries(
            DIMENSIONS.map((d) => [d, Math.round(dims[d] ?? 0)]),
          ) as DimensionScores);
    const weakest = dimensionAvgs ? weakestDimension(dimensionAvgs) : null;

    return {
      ...base,
      hasData: practised.length > 0,
      stats: {
        invited,
        active: cohort.filter((c) => c.first_login_at !== null).length,
        completedSession: practised.length,
        avgBaseline,
        avgLatest,
        change: reportChange(
          avgBaseline,
          avgLatest,
          practised.map((c) => c.sessions_total),
        ),
      },
      bandsLatest: countBands(latests),
      bandsBaseline: countBands(baselines),
      hardestQuestions: pickHardest(questions),
      dimensionAverages: dimensionAvgs,
      weakest,
      weakestNote: weakest ? weakestNote(weakest) : null,
      needsAttention: needsAttention(
        cohort.map((c) => ({
          id: c.id,
          name: c.name?.trim() || c.email,
          email: c.email,
          status: c.status,
          assigned: c.assigned,
          lastActiveAt: c.last_active_at,
          sessionsTotal: c.sessions_total,
          baselineScore: c.baseline_score,
          latestScore: c.latest_score,
          latestBand: c.latest_band as Band | null,
        })),
        now,
      ),
    };
  }

  async exportCsv(
    q: ReportQuery,
    now = new Date(),
  ): Promise<{ filename: string; csv: string }> {
    const r = await this.report(q, now);
    return {
      filename: reportCsvFilename(r.roleTitle, r.range.to),
      csv: toCsv(reportCsvRows(r, q.dateBasis)),
    };
  }
}
