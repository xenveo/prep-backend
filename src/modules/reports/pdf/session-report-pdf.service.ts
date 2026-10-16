// Server-rendered PDF session report (FR-SCORE-04), shared by the candidate and admin downloads.
// pdfmake is a process-wide singleton: fonts and file access are configured once, here. All model
// text goes into the document as plain strings, which pdfmake never interprets as markup.
import { createRequire } from 'node:module';
import { dirname, sep } from 'node:path';
import { Injectable, StreamableFile } from '@nestjs/common';
import pdfmake from 'pdfmake';
import type {
  Content,
  TDocumentDefinitions,
  TFontDictionary,
} from 'pdfmake/interfaces.js';
import type { Dimension } from '../../interview/types.js';
import { attachment } from '../csv.js';
import { formatDay, workspaceDay } from '../format.js';
import type {
  ReportApplied,
  ReportDelivery,
  ReportQuestion,
  ReportTry,
  SessionReportModel,
} from './session-report.model.js';

const require = createRequire(import.meta.url);
const FONTS_FILE = require.resolve('pdfmake/fonts/Roboto.js');
const FONTS_DIR = dirname(FONTS_FILE) + sep;

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const PANEL = '#f3f4f6';
const MARGIN = 48;

const DIMENSION_ORDER: readonly Dimension[] = [
  'content',
  'structure',
  'delivery',
  'relevance',
];

const APPLIED_LABELS: Record<ReportApplied['status'], string> = {
  applied: 'Applied',
  partly: 'Partly',
  not_yet: 'Not yet',
};

/** Typed answers have no voice delivery; their delivery dimension is written clarity. */
const dimensionLabel = (d: Dimension, mode: ReportTry['mode']): string =>
  d === 'delivery'
    ? mode === 'typed'
      ? 'Clarity (written)'
      : 'Delivery'
    : d[0].toUpperCase() + d.slice(1);

/** Averages as the UIs show them: one decimal unless whole ("60.2", "60"); "–" when missing. */
const average = (value: number | null) =>
  value === null ? '–' : String(Math.round(value * 10) / 10);

/** "<1 min" under a minute, like the admin UI's formatMinutes. */
const minutes = (n: number) => (n < 1 ? '<1 min' : `${n} min`);

/** "customer-support-associate-session-3.pdf". Built from the role only, never the candidate. */
export function reportFilename(roleTitle: string, sessionNumber: number) {
  const slug =
    roleTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'practice';
  return `${slug}-session-${sessionNumber}.pdf`;
}

const heading = (text: string): Content => ({ text, style: 'heading' });
const label = (text: string): Content => ({ text, style: 'label' });
const bullets = (items: string[]): Content => ({
  ul: items,
  margin: [0, 2, 0, 6],
});

function scoreBlock(m: SessionReportModel): Content[] {
  const cell = (name: string, value: number | null): Content => ({
    stack: [
      { text: name, style: 'statLabel' },
      { text: average(value), style: 'statValue' },
    ],
  });
  const block: Content[] = [
    {
      table: {
        widths: ['auto', '*'],
        body: [
          [
            {
              text: [
                { text: String(m.score), fontSize: 30, bold: true },
                { text: ' / 100', fontSize: 12, color: MUTED },
              ],
              margin: [10, 8, 18, 8],
            },
            {
              stack: [
                { text: m.bandLabel, fontSize: 14, bold: true },
                ...(m.bandMessage
                  ? [{ text: m.bandMessage, color: MUTED }]
                  : []),
              ],
              margin: [0, 10, 10, 8],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        fillColor: () => PANEL,
      },
      margin: [0, 12, 0, 8],
    },
    {
      table: {
        widths: ['*', '*', '*'],
        body: [
          [
            cell('First try avg', m.firstTryAvg),
            cell('Second try avg', m.secondTryAvg),
            cell('Learning score', m.learningScore),
          ],
        ],
      },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        hLineColor: () => RULE,
        vLineColor: () => RULE,
        paddingLeft: () => 8,
        paddingTop: () => 6,
        paddingBottom: () => 6,
      },
    },
  ];
  if (m.formulaText) {
    block.push({ text: m.formulaText, style: 'small', margin: [0, 6, 0, 0] });
  }
  return block;
}

function subScoreTable(t: ReportTry): Content {
  return {
    table: {
      widths: ['*', '*', '*', '*'],
      body: [
        DIMENSION_ORDER.map((d) => ({
          text: dimensionLabel(d, t.mode),
          style: 'statLabel',
        })),
        DIMENSION_ORDER.map((d) => ({
          text: String(Math.round(t.subScores[d] ?? 0)),
          bold: true,
        })),
      ],
    },
    layout: {
      hLineWidth: (i: number) => (i === 1 ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => RULE,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    fontSize: 9,
    margin: [0, 2, 0, 6],
  };
}

/** Voice metrics: "Pace: 172 wpm · a bit fast", then the target in grey. */
function deliveryBlock(items: ReportDelivery[]): Content[] {
  return [
    label('Delivery'),
    {
      stack: items.map((d) => ({
        text: [
          { text: `${d.label}: `, color: MUTED },
          { text: d.value },
          ...(d.note ? [{ text: ` · ${d.note}`, color: MUTED }] : []),
        ],
      })),
      fontSize: 9,
      margin: [0, 2, 0, 6],
    },
  ];
}

function tryBlock(
  title: string,
  t: ReportTry,
  applied: ReportApplied[],
  lead: Content[] = [],
): Content[] {
  const out: Content[] = [
    {
      // Keeps the question header (for the first try) with its score line and sub-scores.
      stack: [
        ...lead,
        { text: `${title} · ${t.score}`, style: 'tryTitle' },
        subScoreTable(t),
        ...(t.delivery ? deliveryBlock(t.delivery) : []),
      ],
      unbreakable: true,
    },
  ];
  if (t.worked.length) out.push(label('What worked'), bullets(t.worked));
  if (t.improve.length) out.push(label('To improve'), bullets(t.improve));
  if (applied.length) {
    out.push(label('Applied from feedback'), {
      ul: applied.map((a) => ({
        text: [
          { text: a.label },
          { text: ` · ${APPLIED_LABELS[a.status]}`, bold: true },
          ...(a.evidence ? [{ text: `\n${a.evidence}`, color: MUTED }] : []),
        ],
      })),
      margin: [0, 2, 0, 6],
    });
  }
  out.push(label('Transcript'), {
    text: t.transcript.trim() || 'No transcript',
    style: 'transcript',
  });
  return out;
}

function questionBlock(q: ReportQuestion): Content {
  const header: Content[] = [
    {
      text: q.category
        ? `Question ${q.position} · ${q.category}`
        : `Question ${q.position}`,
      style: 'questionKicker',
    },
    { text: q.text, style: 'questionText' },
  ];
  const parts = tryBlock('First try', q.first, [], header);
  if (q.second) {
    parts.push(...tryBlock('Second try', q.second, q.applied));
  } else if (q.retrySkipped) {
    parts.push({ text: 'Second try skipped', style: 'skipped' });
  }
  return { stack: parts, margin: [0, 14, 0, 0] };
}

/** The report layout. Pure, so tests can inspect it without rendering. */
export function buildDocument(m: SessionReportModel): TDocumentDefinitions {
  const meta = [
    `Session ${m.sessionNumber}`,
    formatDay(workspaceDay(new Date(m.date))),
    ...(m.durationMin === null ? [] : [minutes(m.durationMin)]),
  ].join(' · ');

  const content: Content[] = [
    { text: 'PrepPilot · Practice interview report', style: 'kicker' },
    { text: m.roleTitle, style: 'title' },
    { text: meta, style: 'meta' },
    ...(m.candidateName ? [{ text: m.candidateName, style: 'meta' }] : []),
    ...scoreBlock(m),
  ];
  if (m.strengths.length)
    content.push(heading('Strengths'), bullets(m.strengths));
  if (m.focus.length) content.push(heading('Focus areas'), bullets(m.focus));
  if (m.questions.length) {
    content.push(heading('Questions'), ...m.questions.map(questionBlock));
  }

  return {
    info: {
      title: `Practice report: ${m.roleTitle} session ${m.sessionNumber}`,
      author: 'PrepPilot',
      creator: 'PrepPilot',
    },
    pageSize: 'A4',
    pageMargins: [MARGIN, MARGIN, MARGIN, 56],
    defaultStyle: {
      font: 'Roboto',
      fontSize: 10,
      lineHeight: 1.25,
      color: INK,
    },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: 'Practice feedback only. Not a hiring decision.' },
        { text: `Page ${currentPage} of ${pageCount}`, alignment: 'right' },
      ],
      margin: [MARGIN, 20, MARGIN, 0],
      fontSize: 8,
      color: MUTED,
    }),
    content,
    styles: {
      kicker: { fontSize: 9, color: MUTED, characterSpacing: 0.3 },
      title: { fontSize: 20, bold: true, margin: [0, 4, 0, 2] },
      meta: { color: MUTED },
      heading: { fontSize: 13, bold: true, margin: [0, 16, 0, 4] },
      label: { fontSize: 9, bold: true, color: MUTED, margin: [0, 4, 0, 0] },
      small: { fontSize: 9, color: MUTED },
      statLabel: { fontSize: 8, color: MUTED },
      statValue: { fontSize: 14, bold: true },
      questionKicker: { fontSize: 9, bold: true, color: MUTED },
      questionText: { fontSize: 11, bold: true, margin: [0, 2, 0, 6] },
      tryTitle: { fontSize: 10.5, bold: true, margin: [0, 4, 0, 2] },
      transcript: { fontSize: 8.5, color: MUTED, margin: [0, 2, 0, 6] },
      skipped: { italics: true, color: MUTED, margin: [0, 4, 0, 0] },
    },
  };
}

@Injectable()
export class SessionReportPdfService {
  constructor() {
    pdfmake.setFonts(require(FONTS_FILE) as TFontDictionary);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy((path) => path.startsWith(FONTS_DIR));
  }

  buildDocument(model: SessionReportModel): TDocumentDefinitions {
    return buildDocument(model);
  }

  render(model: SessionReportModel): Promise<Buffer> {
    return pdfmake.createPdf(buildDocument(model)).getBuffer();
  }

  /** The PDF as a download. A bare Buffer would be sent as JSON by Nest, so it is wrapped. */
  async download(model: SessionReportModel): Promise<StreamableFile> {
    const pdf = await this.render(model);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: attachment(
        reportFilename(model.roleTitle, model.sessionNumber),
      ),
    });
  }
}
