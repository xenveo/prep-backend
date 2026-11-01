/** Executive dashboard wire contract. All calendar periods/cutoffs use UTC. */
export type ExecutiveRatio = { num: number; den: number; value: number | null };
export type ExecutiveRole = { id: string; name: string; short: string };
export type ExecutiveRecruiter = { id: string; name: string; roles: string[] };
export type ExecutiveMetadata = {
  period: string;
  cohortMonth: string;
  cutoff: string;
  timeZone: 'UTC';
  limitations: string[];
};
export type PerformanceSummary = {
  invited: number;
  acceptance: ExecutiveRatio;
  awaitingAcceptanceWindow: number;
  assignmentPairs: number;
  unassignedCandidates: number;
  paired: number;
  first: number | null;
  latest: number | null;
  gain: number | null;
  improved: number;
  unchanged: number;
  declined: number;
  singleSession: number;
  unassessed: number;
};
export type ExecutiveOverview = {
  meta: ExecutiveMetadata;
  options: {
    periods: string[];
    roles: ExecutiveRole[];
    recruiters: ExecutiveRecruiter[];
  };
  recruiterResults: {
    cohortMonth: string;
    recruiters: (ExecutiveRecruiter & PerformanceSummary)[];
    team: PerformanceSummary;
  };
};
export type ExecutiveCandidate = {
  id: string;
  candidateId: string;
  name: string;
  recruiterId: string;
  roleId: string;
  invitedMonth: string;
  accepted: boolean;
  sessions: number;
  firstScore: number | null;
  latestScore: number | null;
};
export type ExecutiveCandidates = {
  meta: ExecutiveMetadata;
  cohortMonth: string;
  summary: PerformanceSummary;
  roles: (ExecutiveRole & PerformanceSummary)[];
  candidates: ExecutiveCandidate[];
  page: number;
  pageSize: number;
  total: number;
};
export type ExecutiveBands = {
  ready: number;
  nearly: number;
  developing: number;
  not_ready: number;
};
export type ExecutiveFlagType =
  'too_high' | 'too_low' | 'feedback' | 'transcript';
export type ExecutiveInsights = {
  meta: ExecutiveMetadata;
  funnel: {
    invited: number;
    activation: ExecutiveRatio;
    firstPractice: ExecutiveRatio;
    repeatPractice: ExecutiveRatio;
  };
  pipeline: {
    role: ExecutiveRole;
    bands: ExecutiveBands;
    unassessed: number;
    newlyReady: number;
  }[];
  timeToReady: { medianDays: number | null; attainment: ExecutiveRatio };
  dimensions: { id: string; label: string; value: number | null }[];
  hardestQuestions: {
    id: string;
    question: string;
    responses: number;
    first: number | null;
    retry: number | null;
  }[];
  attention: {
    total: number;
    low: number;
    inactive: number;
    both: number;
    historicalInactivityAvailable: boolean;
    cases: {
      candidateId: string;
      name: string;
      roleId: string;
      roleName: string;
      score: number | null;
      reason: 'low' | 'inactive' | 'both';
    }[];
  };
  quality: {
    completion: ExecutiveRatio;
    sessions: {
      started: number;
      completed: number;
      abandoned: number;
      unfinished: number;
    };
    flagRate: number | null;
    resolutionHours: number | null;
    flags: {
      total: number;
      unresolved: number;
      byType: Record<ExecutiveFlagType, number>;
    };
  };
  unavailable: { metric: string; reason: string }[];
};
