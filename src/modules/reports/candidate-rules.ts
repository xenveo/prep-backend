// Candidate list rules, as ../prep-admin-ui/src/services/candidates.ts applies them. Pure functions.
import { bandFor } from '../interview/scoring/score.js';
import type { CsvCell } from './csv.js';
import { BAND_LABEL, csvDateTime, daysSince } from './format.js';
import { toAdminBand } from '../../common/mapping/enums.js';
import type { CandidateQuery } from './reports.schemas.js';
import type {
  CandidateRow,
  CandidateSortColumn,
  ProgressPoint,
  SessionSummaryView,
} from './reports.types.js';

/** Completed sessions, oldest first, as progress points numbered per role ("Session 1" per role). */
export function progressByRole(
  chrono: Pick<SessionSummaryView, 'roleId' | 'roleTitle' | 'date' | 'score'>[],
): ProgressPoint[] {
  const counts = new Map<string, number>();
  return chrono.map((s) => {
    const n = (counts.get(s.roleId) ?? 0) + 1;
    counts.set(s.roleId, n);
    return {
      roleId: s.roleId,
      roleTitle: s.roleTitle,
      label: `Session ${n}`,
      date: s.date,
      score: s.score,
    };
  });
}

/** Does the row pass every filter in the query? `now` drives "active within N days". */
export function matchesQuery(
  row: CandidateRow,
  q: CandidateQuery,
  now: Date,
): boolean {
  const needle = q.search?.trim().toLowerCase();
  if (
    needle &&
    !row.name.toLowerCase().includes(needle) &&
    !row.email.toLowerCase().includes(needle)
  )
    return false;
  if (q.roleIds?.length && !row.roles.some((r) => q.roleIds!.includes(r.id)))
    return false;
  if (q.bands?.length && (row.band === null || !q.bands.includes(row.band)))
    return false;
  if (q.statuses?.length && !q.statuses.includes(row.status)) return false;
  if (q.lastActiveWithinDays !== undefined) {
    if (!row.lastActiveAt) return false;
    if (daysSince(new Date(row.lastActiveAt), now) > q.lastActiveWithinDays)
      return false;
  }
  if (q.noChangeInSessions !== undefined) {
    if (
      row.sessions < q.noChangeInSessions ||
      row.change === null ||
      row.change > 0
    )
      return false;
  }
  return true;
}

function sortValue(
  row: CandidateRow,
  col: CandidateSortColumn,
): string | number | null {
  switch (col) {
    case 'name':
      return row.name.toLowerCase();
    case 'status':
      return row.status;
    case 'sessions':
      return row.sessions;
    case 'score':
      return row.latestScore;
    case 'change':
      return row.change;
    case 'lastActive':
      return row.lastActiveAt;
  }
}

/** Sorted copy. Default: last active, newest first. Nulls sort last in both directions. */
export function sortRows(
  rows: CandidateRow[],
  column: CandidateSortColumn = 'lastActive',
  direction: 'asc' | 'desc' = column === 'lastActive' ? 'desc' : 'asc',
): CandidateRow[] {
  const dir = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, column);
    const bv = sortValue(b, column);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
}

export const CANDIDATE_CSV_HEADER = [
  'Name',
  'Email',
  'Status',
  'Roles',
  'Sessions',
  'Latest score',
  'Band',
  'Change since baseline',
  'Last active',
];

/** Rows for candidates.csv, columns as the admin UI's `exportCandidatesCsv`. */
export function candidateCsvRows(rows: CandidateRow[]): CsvCell[][] {
  return [
    CANDIDATE_CSV_HEADER,
    ...rows.map((r) => [
      r.name,
      r.email,
      r.status.replace('_', ' '),
      r.roles.map((x) => x.title).join('; '),
      r.sessions,
      r.latestScore,
      r.latestScore === null
        ? ''
        : BAND_LABEL[toAdminBand(bandFor(r.latestScore))],
      r.change,
      r.lastActiveAt ? csvDateTime(new Date(r.lastActiveAt)) : '',
    ]),
  ];
}
