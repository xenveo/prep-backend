// Zod schemas for every LLM output (spec "AI interview pipeline", plan §6). The JSON Schema sent to
// the provider is derived from the same schema, and every output is validated with it.
import { z } from 'zod';

const text = z.string().trim().min(1);
const level = z.number().int().min(1).max(5);
export const dimensionSchema = z.enum([
  'content',
  'structure',
  'delivery',
  'relevance',
]);
export const appliedStatusSchema = z.enum(['applied', 'partly', 'not_applied']);
export const cardCategorySchema = z.enum([
  'behavioural',
  'situational',
  'role_knowledge',
  'motivation',
]);
export const difficultySchema = z.enum(['easy', 'medium', 'hard']);
export const expectedStructureSchema = z.enum([
  'star',
  'problem_solution',
  'free',
]);

export const evaluatorOutputSchema = z.object({
  dimension_scores: z.object({
    content: level,
    structure: level,
    delivery: level,
    relevance: level,
  }),
  evidence: z.array(
    z.object({ dimension: dimensionSchema, quote: text, note: z.string() }),
  ),
  worked: z.array(text).min(1).max(4),
  improve: z.array(text).min(1).max(4),
  opener: text,
  improvement_points: z.array(text).min(2).max(3),
  delivery_notes: z.string(),
  spoken_summary: text,
  follow_up: z.string().nullable(),
  applied: z
    .array(
      z.object({
        point: text,
        status: appliedStatusSchema,
        evidence: z.string(),
      }),
    )
    .optional(),
  highlights: z.array(
    z.object({
      quote: text,
      kind: z.enum(['match', 'issue']),
      note: z.string(),
      rubric_point_id: z.string().optional(),
    }),
  ),
});
export type EvaluatorOutput = z.infer<typeof evaluatorOutputSchema>;

const summaryPoint = z.object({
  text,
  question_position: z.number().int().min(1),
});
export const summariserOutputSchema = z.object({
  strengths: z.array(summaryPoint).length(3),
  focus_areas: z.array(summaryPoint).length(3),
});
export type SummariserOutput = z.infer<typeof summariserOutputSchema>;

export const interviewerOutputSchema = z.object({ text });
export type InterviewerOutput = z.infer<typeof interviewerOutputSchema>;

export const draftCardsOutputSchema = z.object({
  cards: z.array(
    z.object({
      category: cardCategorySchema,
      question: text,
      strong_answer_points: z.array(text).length(3),
      common_mistakes: z.array(text).length(2),
      tip: text.max(90),
      sample_answer_outline: z.string().optional(),
    }),
  ),
});
export type DraftCardsOutput = z.infer<typeof draftCardsOutputSchema>;

export const draftQuestionsOutputSchema = z.object({
  questions: z.array(
    z.object({
      text,
      category: cardCategorySchema,
      difficulty: difficultySchema,
      card_position: z.number().int().min(1).nullable(),
      rubric: z.object({
        key_points: z
          .array(z.object({ point: text, example: z.string() }))
          .min(1),
        red_flags: z.array(text),
        expected_structure: expectedStructureSchema,
      }),
    }),
  ),
});
export type DraftQuestionsOutput = z.infer<typeof draftQuestionsOutputSchema>;

/** JSON Schema for `LlmJsonRequest.jsonSchema`. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
}
