import type { ContextPageSize } from 'pdfmake/interfaces.js';
import type { SessionReportModel } from './session-report.model.js';
import {
  buildDocument,
  reportFilename,
  SessionReportPdfService,
} from './session-report-pdf.service.js';

const scores = { content: 70, structure: 60, delivery: 80, relevance: 75 };

const model = (over: Partial<SessionReportModel> = {}): SessionReportModel => ({
  candidateName: 'Neha Kapoor',
  roleTitle: 'Customer Support Associate',
  sessionNumber: 3,
  date: '2026-10-16T05:24:20.000Z',
  durationMin: 24,
  score: 78,
  bandLabel: 'Nearly ready',
  bandMessage: 'Solid base; fix the listed focus areas',
  firstTryAvg: 62,
  secondTryAvg: 62.5,
  learningScore: null,
  formulaText: '20% first try + 55% second try + 25% learning = 78',
  strengths: ['Calm, empathetic opening'],
  focus: ['Quantify the outcome'],
  questions: [
    {
      position: 1,
      text: 'Tell me about an upset customer.',
      category: 'Behavioural',
      first: {
        mode: 'voice',
        score: 62,
        subScores: scores,
        delivery: [
          {
            label: 'Pace',
            value: '172 wpm · a bit fast',
            note: 'Target 120–160',
          },
          { label: 'Longest pause', value: 'Not measured' },
        ],
        worked: ['Clear situation'],
        improve: ['State the result'],
        transcript: 'I listened first <b>and</b> {{name}}.',
      },
      second: {
        mode: 'typed',
        score: 81,
        subScores: scores,
        delivery: null,
        worked: ['Named the result'],
        improve: [],
        transcript: 'Second answer',
      },
      retrySkipped: false,
      applied: [
        { label: 'State the result', status: 'partly', evidence: 'Said 20%' },
      ],
    },
    {
      position: 2,
      text: 'Explain a refund policy.',
      category: null,
      first: {
        mode: 'typed',
        score: 55,
        subScores: scores,
        delivery: null,
        worked: [],
        improve: [],
        transcript: '',
      },
      second: null,
      retrySkipped: true,
      applied: [],
    },
  ],
  ...over,
});

/** Every display string in a pdfmake content tree, in order. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    return ['text', 'stack', 'ul', 'columns', 'table', 'body'].flatMap((k) =>
      k in n ? texts(n[k]) : [],
    );
  }
  return [];
}

const PAGE = {} as ContextPageSize;

describe('buildDocument', () => {
  const doc = buildDocument(model());
  const all = texts(doc.content);
  const has = (s: string) => expect(all).toContain(s);

  it('renders the header, score block and summary lists', () => {
    has('PrepPilot · Practice interview report');
    has('Customer Support Associate');
    has('Session 3 · 16 Oct 2026 · 24 min');
    has('Neha Kapoor');
    has('78');
    has(' / 100');
    has('Nearly ready');
    has('Solid base; fix the listed focus areas');
    has('First try avg');
    has('62');
    has('Second try avg');
    has('62.5');
    has('Learning score');
    has('–');
    has('20% first try + 55% second try + 25% learning = 78');
    has('Strengths');
    has('Calm, empathetic opening');
    has('Focus areas');
    has('Quantify the outcome');
  });

  it('renders each question, both tries and the applied items', () => {
    has('Question 1 · Behavioural');
    has('Tell me about an upset customer.');
    has('First try · 62');
    has('Second try · 81');
    has('What worked');
    has('To improve');
    has('Applied from feedback');
    has('State the result');
    has(' · Partly');
    has('\nSaid 20%');
    has('I listened first <b>and</b> {{name}}.');
    has('Question 2');
    has('Second try skipped');
    has('No transcript');
  });

  it('labels delivery by answer mode', () => {
    // The voice try's sub-score column plus its delivery block heading.
    expect(all.filter((s) => s === 'Delivery')).toHaveLength(2);
    expect(all.filter((s) => s === 'Clarity (written)')).toHaveLength(2);
  });

  it('renders voice delivery metrics, with the note when present', () => {
    has('Pace: ');
    has('172 wpm · a bit fast');
    has(' · Target 120–160');
    has('Longest pause: ');
    has('Not measured');
    expect(all.filter((s) => s.startsWith(' · Target'))).toHaveLength(1);
  });

  it('omits the delivery block for tries without metrics', () => {
    const typedOnly = model();
    typedOnly.questions[0].first.delivery = null;
    const out = texts(buildDocument(typedOnly).content);
    expect(out.filter((s) => s === 'Delivery')).toHaveLength(1);
    expect(out).not.toContain('Pace: ');
  });

  it('shows averages with one decimal unless whole, and short sessions as <1 min', () => {
    const out = texts(
      buildDocument(
        model({
          firstTryAvg: 60.2,
          secondTryAvg: 59.96,
          learningScore: 70,
          durationMin: 0,
        }),
      ).content,
    );
    expect(out).toContain('60.2');
    expect(out).toContain('60');
    expect(out).toContain('70');
    expect(out).not.toContain('59.96');
    expect(out).toContain('Session 3 · 16 Oct 2026 · <1 min');
  });

  it('keeps question headers with their first scores', () => {
    const q1 = (doc.content as { stack?: unknown }[]).find((c) =>
      texts(c).includes('Question 1 · Behavioural'),
    ) as { stack: { unbreakable?: boolean }[] };
    expect(q1.stack[0].unbreakable).toBe(true);
    expect(texts(q1.stack[0])).not.toContain(
      'I listened first <b>and</b> {{name}}.',
    );
  });

  it('leaves out optional parts', () => {
    const bare = texts(
      buildDocument(
        model({
          candidateName: null,
          durationMin: null,
          bandMessage: null,
          formulaText: null,
          strengths: [],
          focus: [],
          questions: [],
        }),
      ).content,
    );
    expect(bare).toContain('Session 3 · 16 Oct 2026');
    expect(bare).not.toContain('Neha Kapoor');
    expect(bare).not.toContain('Strengths');
    expect(bare).not.toContain('Questions');
  });

  it('has a footer on every page and no name in the metadata', () => {
    const footer = (
      doc.footer as (p: number, c: number, s: ContextPageSize) => unknown
    )(2, 5, PAGE);
    expect(texts(footer)).toEqual([
      'Practice feedback only. Not a hiring decision.',
      'Page 2 of 5',
    ]);
    expect(doc.info).toEqual({
      title: 'Practice report: Customer Support Associate session 3',
      author: 'PrepPilot',
      creator: 'PrepPilot',
    });
    expect(doc.pageSize).toBe('A4');
  });
});

describe('reportFilename', () => {
  it('slugs the role title', () => {
    expect(reportFilename('Customer Support Associate (L1)', 3)).toBe(
      'customer-support-associate-l1-session-3.pdf',
    );
    expect(reportFilename('  !!  ', 1)).toBe('practice-session-1.pdf');
  });
});

describe('SessionReportPdfService', () => {
  const service = new SessionReportPdfService();

  it('renders a PDF', async () => {
    const pdf = await service.render(model());
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('wraps it as an attachment download', async () => {
    const file = await service.download(model());
    expect(file.getHeaders()).toMatchObject({
      type: 'application/pdf',
      disposition:
        'attachment; filename="customer-support-associate-session-3.pdf"',
    });
  });
});
