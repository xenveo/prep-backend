// Prisma rows → admin UI shapes (prep-admin-ui src/lib/types.ts) and the candidate FlashCard
// (prep-candidate-ui lib/types.ts). Pure functions.
import type {
  FlashCard,
  JobRole,
  Question,
} from '../../generated/prisma/client.js';
import type { AdminBand } from '../../common/mapping/enums.js';
import { CATEGORY_LABELS } from '../interview/serializers/candidate.serializer.js';
import {
  DEFAULT_ROLE_SETTINGS,
  type RoleSettings,
  type Rubric,
} from '../interview/types.js';

export type AdminJobRole = {
  id: string;
  title: string;
  seniority: JobRole['seniority'];
  status: JobRole['status'];
  description: string;
  keySkills: string[];
  settings: RoleSettings;
  updatedAt: string;
  updatedBy: string | null;
  updatedByName: string | null;
  flashCardCount: number;
  questionCount: number;
  aiDraftCardCount: number;
  aiDraftQuestionCount: number;
  candidatesAssigned: number;
  avgLatestScore: number | null;
  avgLatestBand: AdminBand | null;
};

/** Derived per-role numbers that `toAdminRole` needs besides the row. */
export type RoleDerived = Pick<
  AdminJobRole,
  | 'updatedByName'
  | 'flashCardCount'
  | 'questionCount'
  | 'aiDraftCardCount'
  | 'aiDraftQuestionCount'
  | 'candidatesAssigned'
  | 'avgLatestScore'
  | 'avgLatestBand'
>;

export type AdminFlashCard = {
  id: string;
  roleId: string;
  position: number;
  category: FlashCard['category'];
  question: string;
  strongAnswerPoints: string[];
  sampleAnswerOutline: string | null;
  tip: string;
  commonMistakes: string[];
  status: 'ai_draft' | 'approved';
  /** "ai" or an admin id */
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
};

export type TestEvaluation = {
  answer: string;
  score: number;
  band: AdminBand;
  subScores: Record<'content' | 'structure' | 'delivery' | 'relevance', number>;
  matched: string[];
  issues: string[];
  candidateFeedback: string;
  isTest: true;
};

export type QuestionStats = {
  timesAsked: number;
  avgFirstTry: number | null;
  avgSecondTry: number | null;
  avgLearning: number | null;
};

export const EMPTY_QUESTION_STATS: QuestionStats = {
  timesAsked: 0,
  avgFirstTry: null,
  avgSecondTry: null,
  avgLearning: null,
};

export type AdminQuestion = {
  id: string;
  roleId: string;
  text: string;
  category: Question['category'];
  difficulty: Question['difficulty'];
  status: 'ai_draft' | 'approved';
  rubric: Rubric;
  /** The linked flash card's id (uuid), or null. */
  cardId: string | null;
  sampleEvaluation?: TestEvaluation;
} & QuestionStats;

export type CandidateFlashCard = {
  /** The card's 1-based position. */
  id: number;
  category: string;
  question: string;
  strong: string[];
  /** The sample answer outline (FR-ROLE-03), or null. */
  outline: string | null;
  tip: string;
  mistakes: string[];
};

export function toAdminRole(role: JobRole, d: RoleDerived): AdminJobRole {
  return {
    id: role.id,
    title: role.title,
    seniority: role.seniority,
    status: role.status,
    description: role.descriptionHtml,
    keySkills: role.keySkills,
    // Defaults fill settings added after the role was saved (e.g. followUpEnabled).
    settings: {
      ...DEFAULT_ROLE_SETTINGS,
      ...(role.settings as Partial<RoleSettings> | null),
    },
    updatedAt: role.updatedAt.toISOString(),
    updatedBy: role.updatedBy,
    ...d,
  };
}

/** Archived content is never serialised; it maps to approved defensively. */
const contentStatus = (s: FlashCard['status']): 'ai_draft' | 'approved' =>
  s === 'ai_draft' ? 'ai_draft' : 'approved';

export function toAdminCard(card: FlashCard): AdminFlashCard {
  return {
    id: card.id,
    roleId: card.jobRoleId,
    position: card.position,
    category: card.category,
    question: card.question,
    strongAnswerPoints: card.strongAnswerPoints,
    sampleAnswerOutline: card.sampleAnswerOutline,
    tip: card.tip,
    commonMistakes: card.commonMistakes,
    status: contentStatus(card.status),
    createdBy: card.createdBy ?? 'ai',
    ...(card.approvedBy ? { approvedBy: card.approvedBy } : {}),
    ...(card.approvedAt ? { approvedAt: card.approvedAt.toISOString() } : {}),
  };
}

export function toAdminQuestion(
  q: Question,
  stats: QuestionStats = EMPTY_QUESTION_STATS,
): AdminQuestion {
  return {
    id: q.id,
    roleId: q.jobRoleId,
    text: q.text,
    category: q.category,
    difficulty: q.difficulty,
    status: contentStatus(q.status),
    rubric: q.rubric as Rubric,
    cardId: q.flashCardId,
    ...stats,
    ...(q.sampleEvaluation
      ? { sampleEvaluation: q.sampleEvaluation as TestEvaluation }
      : {}),
  };
}

export function toCandidateCard(card: FlashCard): CandidateFlashCard {
  return {
    id: card.position,
    category: CATEGORY_LABELS[card.category],
    question: card.question,
    strong: card.strongAnswerPoints,
    outline: card.sampleAnswerOutline,
    tip: card.tip,
    mistakes: card.commonMistakes,
  };
}
