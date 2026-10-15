// Request schemas and response types for the candidate interview API (spec "Candidate API").
import { z } from 'zod';
import type { CandidateBand } from '../../common/mapping/enums.js';
import type {
  AppliedItem,
  CandidateAttempt,
  CandidateInterviewQuestion,
  CandidateSession,
  QuestionResult,
  SessionSummary,
} from './types.js';

export const answerModeSchema = z.enum(['voice', 'typed']);

/** POST /roles/:roleId/sessions and POST /admin/roles/:id/preview-session. */
export const startSessionSchema = z.object({
  mode: answerModeSchema,
  consent: z.object({
    recording: z.literal(true),
    text: z.string().trim().min(1).max(2000),
    version: z.string().trim().min(1).max(50),
  }),
});
export type StartSessionBody = z.infer<typeof startSessionSchema>;

export const MAX_TYPED_CHARS = 1500;
export const MAX_ANSWER_SEC = 300;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Multipart text fields of POST /sessions/:id/questions/:questionId/attempts (all arrive as strings). */
export const submitAttemptSchema = z
  .object({
    attemptNo: z.coerce
      .number()
      .int()
      .refine((n) => n === 1 || n === 2, 'must be 1 or 2'),
    mode: answerModeSchema,
    text: z.string().trim().max(MAX_TYPED_CHARS).optional(),
    durationSec: z.coerce.number().min(0).max(MAX_ANSWER_SEC).default(0),
  })
  .refine((b) => b.mode !== 'typed' || !!b.text, {
    message: 'text is required for a typed answer',
    path: ['text'],
  });
export type SubmitAttemptBody = z.infer<typeof submitAttemptSchema>;

export const idempotencyKeySchema = z
  .string({ error: 'Idempotency-Key header is required' })
  .trim()
  .min(1, 'Idempotency-Key header is required')
  .max(200);

/** GET /sessions?roleId= */
export const historyQuerySchema = z.object({
  roleId: z.string().trim().min(1).max(200).optional(),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/** Audio MIME types accepted for voice answers → stored file extension. */
export const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'mp4',
  'audio/mpeg': 'mp3',
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type CandidateRole = {
  id: string;
  name: string;
  blurb: string;
  cardCount: number;
  questionCount: number;
};

export type CandidateRoleStatus =
  | { kind: 'not-started' }
  | { kind: 'studying'; viewed: number }
  | { kind: 'interviewing'; question: number }
  | { kind: 'completed'; score: number; baseline: number | null };

export type RoleWithStatus = CandidateRole & {
  status: CandidateRoleStatus;
  latest: number | null;
  bestBand: CandidateBand | null;
  latestBand: CandidateBand | null;
  /** null = unlimited */
  attemptsLeft: number | null;
  accessExpiresAt: string | null;
};

export type RoleDetail = CandidateRole & {
  cardsRequired: boolean;
  questionsPerSession: number;
  answerSoftLimitSec: number;
  retriesPerQuestion: 1;
};

export type HistoryItem = SessionSummary & { roleId: string };

export type StartedSession = {
  id: string;
  number: number;
  questions: CandidateInterviewQuestion[];
  intro: { text: string; audioUrl: string | null };
  currentQuestion: number;
};

export type InProgressResult = QuestionResult & {
  state: 'awaiting_retry' | 'done';
};

export type InProgressSession = {
  status: 'in_progress';
  mode: 'voice' | 'typed';
  currentQuestion: number;
  questions: CandidateInterviewQuestion[];
  results: InProgressResult[];
  pending: { questionId: string; attemptNo: 1 | 2 } | null;
  failed: { questionId: string; attemptNo: 1 | 2; code: string } | null;
};

export type SessionView = InProgressSession | CandidateSession;

export type AttemptStatusView = {
  status: 'transcribing' | 'evaluating' | 'done' | 'failed';
  attempt?: CandidateAttempt;
  applied?: AppliedItem[];
  followUp?: string;
  code?: string;
};
