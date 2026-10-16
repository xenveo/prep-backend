// Request bodies and queries for the content endpoints (admin UI src/lib/types.ts: RoleInput,
// RolePatch, FlashCardInput, QuestionInput). Unknown keys (e.g. the UI's `id`, `roleId`) are stripped.
import { z } from 'zod';
import {
  cardCategorySchema,
  difficultySchema,
  expectedStructureSchema,
} from '../ai/schemas.js';

/** Admin UI TIP_MAX_LENGTH. */
export const TIP_MAX_LENGTH = 90;
export const OUTLINE_MAX_LENGTH = 1000;

const seniority = z.enum(['entry', 'junior', 'mid', 'senior']);
const title = z.string().trim().min(1, 'Role title is required').max(120);
const skills = z.array(z.string().trim().min(1).max(60)).max(30);
const description = z.string().max(20_000);
const percent = z.number().int().min(0).max(100);

export const roleSettingsSchema = z.object({
  questionsPerSession: z.number().int().min(1).max(20),
  questionOrder: z.enum(['fixed', 'random']),
  answerGuideSeconds: z.number().int().min(15).max(600),
  requireAllCards: z.boolean(),
  maxSessionsPerCandidate: z.number().int().min(1).max(100).nullable(),
  sessionWeights: z.object({
    firstTry: percent,
    secondTry: percent,
    learning: percent,
  }),
  dimensionWeights: z.object({
    content: percent,
    structure: percent,
    delivery: percent,
    relevance: percent,
  }),
});

export const roleStatusQuerySchema = z.object({
  status: z.enum(['draft', 'approved', 'archived']).optional(),
});
export type RoleStatusQuery = z.infer<typeof roleStatusQuerySchema>;

export const roleInputSchema = z.object({
  title,
  seniority,
  description: description.optional(),
  keySkills: skills.optional(),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

export const rolePatchSchema = z.object({
  title: title.optional(),
  seniority: seniority.optional(),
  description: description.optional(),
  keySkills: skills.optional(),
  settings: roleSettingsSchema.optional(),
});
export type RolePatch = z.infer<typeof rolePatchSchema>;

const line = z.string().trim().min(1).max(500);

export const flashCardInputSchema = z.object({
  category: cardCategorySchema,
  question: z.string().trim().min(1, 'Question is required').max(500),
  strongAnswerPoints: z.array(line).max(10),
  /** Trimmed; empty becomes null. Omitted leaves the stored outline unchanged on update. */
  sampleAnswerOutline: z
    .string()
    .trim()
    .max(
      OUTLINE_MAX_LENGTH,
      `Sample answer outline must be ${OUTLINE_MAX_LENGTH} characters or fewer`,
    )
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  tip: z
    .string()
    .trim()
    .max(TIP_MAX_LENGTH, `Tip must be ${TIP_MAX_LENGTH} characters or fewer`),
  commonMistakes: z.array(line).max(10),
  status: z.enum(['ai_draft', 'approved']).optional(),
});
export type FlashCardInput = z.infer<typeof flashCardInputSchema>;

export const reorderSchema = z.object({
  orderedIds: z.array(z.uuid()).min(1),
});
export type ReorderInput = z.infer<typeof reorderSchema>;

export const rubricInputSchema = z.object({
  keyPoints: z
    .array(
      z.object({
        point: z.string().trim().min(1).max(300),
        example: z.string().trim().max(500).default(''),
      }),
    )
    .max(10),
  redFlags: z.array(z.string().trim().min(1).max(300)).max(10),
  expectedStructure: expectedStructureSchema,
});

export const questionInputSchema = z.object({
  text: z.string().trim().min(1, 'Question text is required').max(500),
  category: cardCategorySchema,
  difficulty: difficultySchema,
  rubric: rubricInputSchema,
  /** The flash card (uuid) this question is drawn from. */
  cardId: z.uuid().nullable().optional(),
  status: z.enum(['ai_draft', 'approved']).optional(),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const draftCountSchema = (fallback: number) =>
  z
    .object({ count: z.number().int().min(1).max(10).default(fallback) })
    .default({ count: fallback });

export const testAnswerSchema = z.object({
  answer: z.string().trim().min(1, 'Type a sample answer first').max(1500),
});
export type TestAnswerInput = z.infer<typeof testAnswerSchema>;

export const uuidParam = z.uuid();
export const positionParam = z.coerce.number().int().min(1);
