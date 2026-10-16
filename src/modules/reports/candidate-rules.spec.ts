import {
  CANDIDATE_CSV_HEADER,
  candidateCsvRows,
  matchesQuery,
  progressByRole,
  sortRows,
} from './candidate-rules.js';
import { toCsv } from './csv.js';
import type { CandidateRow } from './reports.types.js';

const NOW = new Date('2026-10-15T06:00:00Z'); // 11:30 IST

const row = (over: Partial<CandidateRow>): CandidateRow => ({
  id: 'c',
  name: 'Name',
  email: 'name@example.com',
  status: 'active',
  roles: [],
  sessions: 0,
  latestScore: null,
  band: null,
  change: null,
  lastActiveAt: null,
  lastActiveLabel: 'Not yet',
  ...over,
});

describe('progressByRole', () => {
  const point = (roleId: string, date: string, score: number) => ({
    roleId,
    roleTitle: roleId === 'a' ? 'Analyst' : 'Support',
    date,
    score,
  });

  it('numbers each role on its own and keeps the oldest-first order', () => {
    expect(
      progressByRole([
        point('a', '2026-10-01T00:00:00.000Z', 39),
        point('s', '2026-10-02T00:00:00.000Z', 61),
        point('a', '2026-10-03T00:00:00.000Z', 52),
        point('s', '2026-10-04T00:00:00.000Z', 70),
        point('s', '2026-10-05T00:00:00.000Z', 74),
      ]),
    ).toEqual([
      { ...point('a', '2026-10-01T00:00:00.000Z', 39), label: 'Session 1' },
      { ...point('s', '2026-10-02T00:00:00.000Z', 61), label: 'Session 1' },
      { ...point('a', '2026-10-03T00:00:00.000Z', 52), label: 'Session 2' },
      { ...point('s', '2026-10-04T00:00:00.000Z', 70), label: 'Session 2' },
      { ...point('s', '2026-10-05T00:00:00.000Z', 74), label: 'Session 3' },
    ]);
  });

  it('is empty without completed sessions', () => {
    expect(progressByRole([])).toEqual([]);
  });
});

describe('matchesQuery', () => {
  const priya = row({
    id: 'p',
    name: 'Priya Sharma',
    email: 'priya@acme.test',
    roles: [{ id: 'r1', title: 'CSA', status: 'approved' }],
    sessions: 3,
    latestScore: 64,
    band: 'developing',
    change: 0,
    lastActiveAt: '2026-10-13T05:00:00.000Z',
  });

  it('searches name and email case-insensitively', () => {
    expect(matchesQuery(priya, { search: 'SHARMA' }, NOW)).toBe(true);
    expect(matchesQuery(priya, { search: ' Acme.TEST ' }, NOW)).toBe(true);
    expect(matchesQuery(priya, { search: 'rahul' }, NOW)).toBe(false);
  });

  it('filters by role, band and status', () => {
    expect(matchesQuery(priya, { roleIds: ['r2', 'r1'] }, NOW)).toBe(true);
    expect(matchesQuery(priya, { roleIds: ['r2'] }, NOW)).toBe(false);
    expect(matchesQuery(priya, { bands: ['developing'] }, NOW)).toBe(true);
    expect(matchesQuery(row({}), { bands: ['developing'] }, NOW)).toBe(false);
    expect(matchesQuery(priya, { statuses: ['invite_pending'] }, NOW)).toBe(
      false,
    );
  });

  it('counts "active within N days" in calendar days and drops never-active rows', () => {
    expect(matchesQuery(priya, { lastActiveWithinDays: 2 }, NOW)).toBe(true);
    expect(matchesQuery(priya, { lastActiveWithinDays: 1 }, NOW)).toBe(false);
    expect(matchesQuery(row({}), { lastActiveWithinDays: 30 }, NOW)).toBe(
      false,
    );
  });

  it('noChangeInSessions needs N sessions and change <= 0', () => {
    expect(matchesQuery(priya, { noChangeInSessions: 3 }, NOW)).toBe(true);
    expect(matchesQuery(priya, { noChangeInSessions: 4 }, NOW)).toBe(false);
    expect(
      matchesQuery({ ...priya, change: 5 }, { noChangeInSessions: 2 }, NOW),
    ).toBe(false);
    expect(
      matchesQuery({ ...priya, change: null }, { noChangeInSessions: 2 }, NOW),
    ).toBe(false);
  });
});

describe('sortRows', () => {
  const a = row({
    id: 'a',
    name: 'b',
    latestScore: 70,
    lastActiveAt: '2026-10-14T00:00:00.000Z',
  });
  const b = row({ id: 'b', name: 'A', latestScore: null, lastActiveAt: null });
  const c = row({
    id: 'c',
    name: 'c',
    latestScore: 40,
    lastActiveAt: '2026-10-15T00:00:00.000Z',
  });
  const ids = (rows: CandidateRow[]) => rows.map((r) => r.id);

  it('defaults to last active, newest first, nulls last', () => {
    expect(ids(sortRows([a, b, c]))).toEqual(['c', 'a', 'b']);
  });

  it('puts nulls last in both directions', () => {
    expect(ids(sortRows([a, b, c], 'score', 'asc'))).toEqual(['c', 'a', 'b']);
    expect(ids(sortRows([a, b, c], 'score', 'desc'))).toEqual(['a', 'c', 'b']);
  });

  it('sorts names case-insensitively, ascending by default', () => {
    expect(ids(sortRows([a, b, c], 'name'))).toEqual(['b', 'a', 'c']);
  });
});

describe('candidateCsvRows', () => {
  it('uses the admin UI column order and formats', () => {
    const rows = candidateCsvRows([
      row({
        name: 'Priya Sharma',
        email: 'priya@acme.test',
        status: 'invite_pending',
        roles: [
          { id: 'r1', title: 'CSA', status: 'approved' },
          { id: 'r2', title: 'JDA', status: 'approved' },
        ],
        sessions: 2,
        latestScore: 84,
        change: -3,
        lastActiveAt: '2026-10-15T05:12:00.000Z',
      }),
      row({ name: 'Rahul', email: 'r@x.test' }),
    ]);
    expect(rows[0]).toEqual(CANDIDATE_CSV_HEADER);
    expect(toCsv(rows)).toBe(
      'Name,Email,Status,Roles,Sessions,Latest score,Band,Change since baseline,Last active\r\n' +
        'Priya Sharma,priya@acme.test,invite pending,CSA; JDA,2,84,Nearly ready,-3,2026-10-15 10:42\r\n' +
        'Rahul,r@x.test,active,,0,,,,\r\n',
    );
  });
});
