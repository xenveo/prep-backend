import { Inject, Injectable } from '@nestjs/common';
import {
  LLM_ADAPTER,
  LlmUnavailableError,
  type LlmAdapter,
} from '../../adapters/llm/llm.adapter.js';
import type {
  CardCategory,
  Difficulty,
  Seniority,
} from '../../generated/prisma/client.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Rubric } from '../interview/types.js';
import { AiCallLogService } from './ai-call-log.service.js';
import {
  LlmOutputInvalidError,
  requestValidated,
  type ValidatedCall,
} from './llm-json.js';
import { findHiringVerdict } from './moderation.js';
import { PromptService } from './prompt.service.js';
import { escapeXml, renderTemplate } from './prompts/render.js';
import {
  draftCardsOutputSchema,
  draftQuestionsOutputSchema,
} from './schemas.js';

export type DraftRoleContext = {
  roleTitle: string;
  /** Plain text of the role description (HTML stripped by the caller). */
  descriptionText: string;
  keySkills: string[];
  seniority: Seniority;
  /** Existing question texts (cards and questions) to avoid repeating. */
  existingQuestions: string[];
  count: number;
};

export type DraftCard = {
  category: CardCategory;
  question: string;
  strongAnswerPoints: string[];
  commonMistakes: string[];
  tip: string;
  sampleAnswerOutline: string | null;
};

export type DraftQuestion = {
  text: string;
  category: CardCategory;
  difficulty: Difficulty;
  /** Card position this question draws from, or null when it matches none. */
  cardPosition: number | null;
  rubric: Rubric;
};

export type DraftQuestionsInput = DraftRoleContext & {
  cards: { position: number; question: string; category: CardCategory }[];
};

/** Normalised text for duplicate checks. */
export const dedupeKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** AI drafting of flash cards and questions for admin review (FR-ROLE-06/07). Drafts are never auto-approved. */
@Injectable()
export class DrafterService {
  constructor(
    @Inject(LLM_ADAPTER) private readonly llm: LlmAdapter,
    private readonly prompts: PromptService,
    private readonly callLog: AiCallLogService,
  ) {}

  async draftCards(input: DraftRoleContext): Promise<DraftCard[]> {
    const output = await this.call(input, {
      tag: 'draft-cards',
      schema: draftCardsOutputSchema,
      task: `Task: draft flash cards.\nNumber to draft: ${input.count}`,
      check: (o) =>
        moderationProblem(
          o.cards.flatMap((c) => [
            c.question,
            c.tip,
            ...c.strong_answer_points,
            ...c.common_mistakes,
          ]),
        ),
    });
    const cards = output.cards.map((c) => ({
      category: c.category,
      question: c.question,
      strongAnswerPoints: c.strong_answer_points,
      commonMistakes: c.common_mistakes,
      tip: c.tip,
      sampleAnswerOutline: c.sample_answer_outline?.trim() || null,
    }));
    return dedupe(cards, (c) => c.question, input.existingQuestions).slice(
      0,
      input.count,
    );
  }

  async draftQuestions(input: DraftQuestionsInput): Promise<DraftQuestion[]> {
    const cardList = input.cards
      .map(
        (c) =>
          `<card position="${c.position}" category="${c.category}">${escapeXml(c.question)}</card>`,
      )
      .join('\n');
    const output = await this.call(input, {
      tag: 'draft-questions',
      schema: draftQuestionsOutputSchema,
      task: `Task: draft interview questions, each linked to the card it draws from by card_position.\nNumber to draft: ${input.count}\n\nFlash cards:\n${cardList || 'none'}`,
      check: (o) =>
        moderationProblem(
          o.questions.flatMap((q) => [q.text, ...q.rubric.red_flags]),
        ),
    });
    const positions = new Set(input.cards.map((c) => c.position));
    const questions = output.questions.map((q) => ({
      text: q.text,
      category: q.category,
      difficulty: q.difficulty,
      cardPosition:
        q.card_position !== null && positions.has(q.card_position)
          ? q.card_position
          : null,
      rubric: {
        keyPoints: q.rubric.key_points.map((k, i) => ({
          id: `kp${i + 1}`,
          point: k.point,
          example: k.example,
        })),
        redFlags: q.rubric.red_flags,
        expectedStructure: q.rubric.expected_structure,
      },
    }));
    return dedupe(questions, (q) => q.text, input.existingQuestions).slice(
      0,
      input.count,
    );
  }

  private async call<T>(
    input: DraftRoleContext,
    spec: Pick<ValidatedCall<T>, 'tag' | 'schema' | 'check'> & { task: string },
  ): Promise<T> {
    const prompt = await this.prompts.getActive('drafter');
    const existing =
      input.existingQuestions.map((q) => `- ${escapeXml(q)}`).join('\n') ||
      'none';
    try {
      return await requestValidated(this.llm, this.callLog, {
        ...spec,
        prompt,
        system: renderTemplate(prompt.template, {
          role_title: input.roleTitle,
          seniority: input.seniority,
          key_skills: input.keySkills.join(', ') || 'not specified',
        }),
        user: `${spec.task}\n\nExisting questions (do not repeat):\n${existing}\n\n<role_description>\n${escapeXml(input.descriptionText)}\n</role_description>`,
      });
    } catch (err) {
      if (
        err instanceof LlmUnavailableError ||
        err instanceof LlmOutputInvalidError
      ) {
        throw new AppError(
          'ai_unavailable',
          503,
          'AI drafting is unavailable right now. Try again shortly.',
        );
      }
      throw err;
    }
  }
}

function moderationProblem(texts: string[]): string | null {
  const hit = findHiringVerdict(texts.join('\n'));
  return hit ? `Remove hiring-decision language ("${hit}").` : null;
}

function dedupe<T>(
  items: T[],
  textOf: (item: T) => string,
  existing: string[],
): T[] {
  const seen = new Set(existing.map(dedupeKey));
  return items.filter((item) => {
    const key = dedupeKey(textOf(item));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
