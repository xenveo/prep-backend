// Zod schemas for the admin read-model queries and flag bodies.
// Express 5's simple query parser yields a string for `?a=x`, an array for `?a=x&a=y`, and keeps
// `a[]` as a literal key, so list params accept all three forms.
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../../common/errors/app-error.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const ADMIN_BANDS = ['ready', 'nearly', 'developing', 'not_ready'] as const;
const STATUSES = [
  'invite_pending',
  'active',
  'deactivated',
  'revoked',
] as const;
const SORT_COLUMNS = [
  'name',
  'status',
  'sessions',
  'score',
  'change',
  'lastActive',
] as const;

const day = z
  .string()
  .regex(DAY, 'Expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');

/** Lifts `key[]` into `key` and merges, so `?k=a&k[]=b` reads as `{k: ['a', 'b']}`. */
function mergeBracketKeys(keys: readonly string[]) {
  return (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const out: Record<string, unknown> = { ...raw };
    for (const k of keys) {
      const values = [out[k], out[`${k}[]`]]
        .flat()
        .filter((v) => v !== undefined && v !== '');
      delete out[`${k}[]`];
      out[k] = values.length ? values : undefined;
    }
    return out;
  };
}

const list = <T extends z.ZodType>(item: T) => z.array(item).optional();

export const candidateQuerySchema = z.preprocess(
  mergeBracketKeys(['roleIds', 'bands', 'statuses']),
  z.object({
    search: z.string().max(200).optional(),
    roleIds: list(z.uuid()),
    bands: list(z.enum(ADMIN_BANDS)),
    statuses: list(z.enum(STATUSES)),
    lastActiveWithinDays: z.coerce.number().int().min(0).optional(),
    noChangeInSessions: z.coerce.number().int().min(0).optional(),
    sort: z.enum(SORT_COLUMNS).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
  }),
);
export type CandidateQuery = z.output<typeof candidateQuerySchema>;

export const candidateExportSchema = z.preprocess(
  mergeBracketKeys(['ids']),
  z.object({ ids: list(z.uuid()) }),
);

export const reportQuerySchema = z
  .object({
    roleId: z.uuid(),
    from: day.optional(),
    to: day.optional(),
    dateBasis: z.enum(['completed', 'invited']).default('completed'),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });
export type ReportQuery = z.output<typeof reportQuerySchema>;

export const flagInputSchema = z.object({
  /** Optional echo of the path id; must match it when sent. */
  sessionId: z.uuid().optional(),
  questionNumber: z.number().int().min(1),
  dimension: z.enum([
    'content',
    'structure',
    'delivery',
    'relevance',
    'overall',
    'feedback',
  ]),
  issue: z.enum([
    'too_high',
    'too_low',
    'feedback_inaccurate',
    'transcript_wrong',
  ]),
  note: z.string().max(2000).optional(),
});
export type FlagInput = z.output<typeof flagInputSchema>;

export const resolveFlagSchema = z.object({
  status: z.literal('resolved'),
  resolution: z.string().trim().min(1).max(2000),
});
export type ResolveFlagInput = z.output<typeof resolveFlagSchema>;

/** Path ids are uuids; anything else can't exist, so it is a 404 rather than a 400. */
export class UuidParamPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw notFound();
    return parsed.data;
  }
}
