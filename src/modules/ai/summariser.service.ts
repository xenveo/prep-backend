import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LLM_ADAPTER,
  type LlmAdapter,
} from '../../adapters/llm/llm.adapter.js';
import { AiCallLogService } from './ai-call-log.service.js';
import { requestValidated } from './llm-json.js';
import { findHiringVerdict } from './moderation.js';
import { PromptService } from './prompt.service.js';
import { escapeXml, renderTemplate } from './prompts/render.js';
import { summariserOutputSchema, type SummariserOutput } from './schemas.js';

export type SummariseQuestion = {
  position: number;
  text: string;
  firstScore: number;
  /** null = retry skipped */
  secondScore: number | null;
  improvementPoints: string[];
  worked: string[];
};

export type SummariseInput = {
  roleTitle: string;
  questions: SummariseQuestion[];
  sessionId: string;
};

export type SummaryPoint = { text: string; questionPosition: number };

export type SummariseResult = {
  strengths: SummaryPoint[];
  focusAreas: SummaryPoint[];
  source: 'llm' | 'fallback';
};

/**
 * Session strengths and focus areas (SRS 7.2 summariser, spec "Scoring"). Never fails: on any LLM
 * problem it derives them from the best and weakest questions, so completing a session always works.
 */
@Injectable()
export class SummariserService {
  private readonly logger = new Logger(SummariserService.name);

  constructor(
    @Inject(LLM_ADAPTER) private readonly llm: LlmAdapter,
    private readonly prompts: PromptService,
    private readonly callLog: AiCallLogService,
  ) {}

  async summarise(input: SummariseInput): Promise<SummariseResult> {
    if (input.questions.length === 0)
      return { strengths: [], focusAreas: [], source: 'fallback' };
    const positions = new Set(input.questions.map((q) => q.position));
    try {
      const prompt = await this.prompts.getActive('summariser');
      const output = await requestValidated(this.llm, this.callLog, {
        tag: 'summariser',
        prompt,
        system: renderTemplate(prompt.template, {
          role_title: input.roleTitle,
          question_count: input.questions.length,
        }),
        user: buildSummariserUserMessage(input.questions),
        schema: summariserOutputSchema,
        check: (o: SummariserOutput) => {
          const all = [...o.strengths, ...o.focus_areas];
          if (all.some((p) => !positions.has(p.question_position))) {
            return `question_position must be one of: ${[...positions].join(', ')}.`;
          }
          return findHiringVerdict(all.map((p) => p.text).join('\n'))
            ? 'Remove hiring-decision language; coach only.'
            : null;
        },
        sessionId: input.sessionId,
      });
      const map = (p: { text: string; question_position: number }) => ({
        text: p.text,
        questionPosition: p.question_position,
      });
      return {
        strengths: output.strengths.map(map),
        focusAreas: output.focus_areas.map(map),
        source: 'llm',
      };
    } catch (err) {
      this.logger.warn(
        `summariser fallback for session ${input.sessionId}: ${(err as Error).name}`,
      );
      return { ...fallbackSummary(input.questions), source: 'fallback' };
    }
  }
}

function buildSummariserUserMessage(questions: SummariseQuestion[]): string {
  return questions
    .map((q) =>
      [
        `<question position="${q.position}">`,
        `text: ${escapeXml(q.text)}`,
        `first try score: ${q.firstScore}`,
        `second try score: ${q.secondScore ?? 'skipped'}`,
        `what worked: ${q.worked.map(escapeXml).join('; ') || 'none'}`,
        `improvement points: ${q.improvementPoints.map(escapeXml).join('; ') || 'none'}`,
        '</question>',
      ].join('\n'),
    )
    .join('\n');
}

const best = (q: SummariseQuestion) => q.secondScore ?? q.firstScore;

/** Up to 3 strengths from the best questions and 3 focus areas from the weakest, cycling when fewer. */
export function fallbackSummary(
  questions: SummariseQuestion[],
): Omit<SummariseResult, 'source'> {
  const byScore = [...questions].sort(
    (a, b) => best(b) - best(a) || a.position - b.position,
  );
  return {
    strengths: pickPoints(
      byScore,
      (q) => q.worked,
      (q) => `Your answer to question ${q.position} was one of your strongest.`,
    ),
    focusAreas: pickPoints(
      [...byScore].reverse(),
      (q) => q.improvementPoints,
      (q) => `Practise question ${q.position} again with its flash card.`,
    ),
  };
}

function pickPoints(
  ranked: SummariseQuestion[],
  texts: (q: SummariseQuestion) => string[],
  fallback: (q: SummariseQuestion) => string,
): SummaryPoint[] {
  const used = new Map<number, number>();
  return Array.from({ length: 3 }, (_, i) => {
    const q = ranked[i % ranked.length];
    const n = used.get(q.position) ?? 0;
    used.set(q.position, n + 1);
    const options = texts(q);
    return {
      text: options.length ? options[n % options.length] : fallback(q),
      questionPosition: q.position,
    };
  });
}
