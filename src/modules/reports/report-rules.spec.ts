import { toCsv } from './csv.js';
import {
  type AttentionCandidate,
  countBands,
  emptyBands,
  needsAttention,
  pickHardest,
  rangeWithBasis,
  reportChange,
  reportCsvFilename,
  reportCsvRows,
  reportRange,
  roundedMean,
  weakestDimension,
  weakestNote,
} from './report-rules.js';
import type { Report } from './reports.types.js';

const NOW = new Date('2026-10-15T06:00:00Z');

describe('reportRange', () => {
  it('defaults to the last 30 days ending today (IST), with day bounds in IST', () => {
    const r = reportRange({}, NOW);
    expect(r).toMatchObject({
      from: '2026-09-15',
      to: '2026-10-15',
      label: 'Last 30 days · 15 Sep – 15 Oct 2026',
    });
    expect(r.start.toISOString()).toBe('2026-09-14T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-15T18:30:00.000Z');
  });

  it('labels anything else a custom range', () => {
    expect(
      reportRange({ from: '2025-12-01', to: '2026-01-10' }, NOW).label,
    ).toBe('Custom range · 1 Dec 2025 – 10 Jan 2026');
  });

  it('states the date basis in the CSV range row', () => {
    expect(rangeWithBasis('Last 30 days · x', 'completed')).toBe(
      'Last 30 days · x · by session completion date',
    );
    expect(rangeWithBasis('L', 'invited')).toBe('L · by invite date');
  });
});

describe('weakestDimension', () => {
  it('picks the lowest, ties to the first in dimension order', () => {
    const w = weakestDimension({
      content: 70,
      structure: 61,
      delivery: 61,
      relevance: 72,
    });
    expect(w).toEqual({ id: 'structure', label: 'Structure', value: 61 });
    expect(weakestNote(w)).toBe(
      'Structure is the weakest area. Consider a flash card on STAR.',
    );
  });
});

describe('bands and means', () => {
  it('counts admin bands at the edges', () => {
    expect(countBands([49, 50, 69, 70, 84, 85])).toEqual({
      not_ready: 1,
      developing: 2,
      nearly: 2,
      ready: 1,
    });
  });

  it('rounds means and returns null for none', () => {
    expect(roundedMean([50, 51])).toBe(51);
    expect(roundedMean([])).toBeNull();
  });
});

describe('pickHardest', () => {
  const q = (id: string, timesAsked: number, avgFirst: number) => ({
    questionId: id,
    question: id,
    timesAsked,
    avgFirst,
    avgSecond: avgFirst + 10.4,
    avgLearning: null,
  });

  it('needs 3 asks and sorts by lowest average first try', () => {
    const out = pickHardest([q('a', 3, 60), q('b', 2, 10), q('c', 5, 40.6)]);
    expect(out.map((h) => h.questionId)).toEqual(['c', 'a']);
    expect(out[0]).toMatchObject({
      avgFirst: 41,
      avgSecond: 51,
      avgLearning: null,
    });
  });

  it('caps the list', () => {
    const rows = Array.from({ length: 8 }, (_, i) => q(`q${i}`, 3, i));
    expect(pickHardest(rows)).toHaveLength(5);
  });
});

describe('needsAttention', () => {
  const base: AttentionCandidate = {
    id: 'c1',
    name: 'Asha',
    email: 'asha@x.test',
    status: 'active',
    assigned: true,
    lastActiveAt: new Date('2026-10-14T06:00:00Z'),
    sessionsTotal: 1,
    baselineScore: 45,
    latestScore: 45,
    latestBand: 'not_ready',
  };

  it('flags a latest score under 50', () => {
    expect(needsAttention([base], NOW)[0]).toMatchObject({
      why: 'Not ready yet',
      lastActiveLabel: 'Yesterday',
      sessions: 1,
    });
  });

  it('notes no change over N sessions', () => {
    const c = { ...base, sessionsTotal: 3, baselineScore: 48 };
    expect(needsAttention([c], NOW)[0].why).toBe(
      'Not ready yet, no change over 3 sessions',
    );
  });

  it('flags 14+ days without activity, not 13', () => {
    const at = (days: number) => ({
      ...base,
      latestScore: 80,
      latestBand: 'nearly_ready' as const,
      lastActiveAt: new Date(NOW.getTime() - days * 864e5),
    });
    expect(needsAttention([at(13)], NOW)).toEqual([]);
    expect(needsAttention([at(14)], NOW)[0].why).toBe(
      'No activity for 14 days',
    );
  });

  it('skips pending, revoked and unassigned candidates; never-active is not inactive', () => {
    expect(
      needsAttention(
        [
          { ...base, status: 'invite_pending' },
          { ...base, status: 'revoked' },
          { ...base, assigned: false },
          { ...base, latestScore: null, latestBand: null, lastActiveAt: null },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('sorts by latest score, missing last', () => {
    const rows = needsAttention(
      [
        {
          ...base,
          id: 'idle',
          latestScore: null,
          latestBand: null,
          lastActiveAt: new Date('2026-09-01T00:00:00Z'),
        },
        { ...base, id: 'b', latestScore: 30 },
        { ...base, id: 'a' },
      ],
      NOW,
    );
    expect(rows.map((r) => r.candidateId)).toEqual(['b', 'a', 'idle']);
  });
});

describe('reportChange', () => {
  it('is latest − baseline once some candidate has two sessions', () => {
    expect(reportChange(50, 60, [1, 2])).toBe(10);
    expect(reportChange(60, 55, [3])).toBe(-5);
    expect(reportChange(60, 60, [2])).toBe(0);
  });

  it('is null while every candidate has a single session, or there is no data', () => {
    expect(reportChange(60, 60, [1, 1])).toBeNull();
    expect(reportChange(null, null, [])).toBeNull();
  });
});

describe('report CSV', () => {
  const report: Report = {
    roleId: 'r',
    roleTitle: 'Customer Support Associate',
    range: {
      from: '2026-09-15',
      to: '2026-10-15',
      label: 'Last 30 days · 15 Sep – 15 Oct 2026',
    },
    hasData: true,
    stats: {
      invited: 3,
      active: 2,
      completedSession: 2,
      avgBaseline: 50,
      avgLatest: 60,
      change: 10,
    },
    bandsLatest: { ...emptyBands(), developing: 1, nearly: 1 },
    bandsBaseline: { ...emptyBands(), not_ready: 1, developing: 1 },
    hardestQuestions: [
      {
        question: 'Tell me, "why"?',
        timesAsked: 3,
        avgFirst: 40,
        avgSecond: 50,
        avgLearning: null,
      },
    ],
    dimensionAverages: {
      content: 60,
      structure: 50,
      delivery: 55,
      relevance: 70,
    },
    weakest: null,
    weakestNote: null,
    needsAttention: [],
    illustrative: [],
  };

  it('lays rows out like exportReportCsv', () => {
    expect(toCsv(reportCsvRows(report, 'completed'))).toBe(
      [
        'Report,Customer Support Associate',
        'Range,Last 30 days · 15 Sep – 15 Oct 2026 · by session completion date',
        '',
        'Metric,Value',
        'Invited,3',
        'Active,2',
        'Completed a session,2',
        'Average baseline,50',
        'Average latest,60',
        'Change,10',
        '',
        'Band,Baseline,Latest,Change',
        'Interview ready,0,0,0',
        'Nearly ready,0,1,1',
        'Developing,1,1,0',
        'Not ready yet,1,0,-1',
        '',
        'Dimension,Average',
        'Content,60',
        'Structure,50',
        'Delivery,55',
        'Relevance,70',
        '',
        'Hardest question,Times asked,Avg first try,Avg second try,Learning',
        '"Tell me, ""why""?",3,40,50,',
        '',
      ].join('\r\n'),
    );
  });

  it('leaves Change empty when it is null, like the other null metrics', () => {
    const csv = toCsv(
      reportCsvRows(
        {
          ...report,
          stats: { ...report.stats, avgBaseline: null, change: null },
        },
        'completed',
      ),
    ).split('\r\n');
    expect(csv).toContain('Average baseline,');
    expect(csv).toContain('Change,');
  });

  it('names the file after the role and end date', () => {
    expect(reportCsvFilename('Customer Support Associate!', '2026-10-15')).toBe(
      'report-customer-support-associate-2026-10-15.csv',
    );
  });
});
