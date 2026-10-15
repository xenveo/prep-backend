// Canonical enum values (DB, API internals) and their per-UI spellings. Plan §10.
import type { Band } from '../../generated/prisma/client.js';

export type CandidateBand = 'not-ready' | 'developing' | 'nearly-ready' | 'interview-ready';
export type AdminBand = 'not_ready' | 'developing' | 'nearly' | 'ready';

export type AppliedStatus = 'applied' | 'partly' | 'not_applied';
export type CandidateAppliedStatus = 'applied' | 'partly' | 'not-yet';
export type AdminAppliedState = 'done' | 'partial' | 'missed';

const CANDIDATE_BAND: Record<Band, CandidateBand> = {
  not_ready: 'not-ready',
  developing: 'developing',
  nearly_ready: 'nearly-ready',
  interview_ready: 'interview-ready',
};

const ADMIN_BAND: Record<Band, AdminBand> = {
  not_ready: 'not_ready',
  developing: 'developing',
  nearly_ready: 'nearly',
  interview_ready: 'ready',
};

const CANDIDATE_APPLIED: Record<AppliedStatus, CandidateAppliedStatus> = {
  applied: 'applied',
  partly: 'partly',
  not_applied: 'not-yet',
};

const ADMIN_APPLIED: Record<AppliedStatus, AdminAppliedState> = {
  applied: 'done',
  partly: 'partial',
  not_applied: 'missed',
};

export const toCandidateBand = (band: Band): CandidateBand => CANDIDATE_BAND[band];
export const toAdminBand = (band: Band): AdminBand => ADMIN_BAND[band];

export function fromAdminBand(band: AdminBand): Band {
  const entry = Object.entries(ADMIN_BAND).find(([, v]) => v === band);
  if (!entry) throw new Error(`Unknown admin band ${band}`);
  return entry[0] as Band;
}

export const toCandidateApplied = (s: AppliedStatus): CandidateAppliedStatus => CANDIDATE_APPLIED[s];
export const toAdminApplied = (s: AppliedStatus): AdminAppliedState => ADMIN_APPLIED[s];
