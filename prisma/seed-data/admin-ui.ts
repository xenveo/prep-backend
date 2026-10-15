// Copied from prep-admin-ui/src/data/sample-data.json and src/services/store.ts (saved filters).
// Placeholder emails like "[arjun@company.com]" are stored without the brackets.

export type AdminFixtureRole = {
  title: string;
  seniority: 'entry' | 'junior' | 'mid' | 'senior';
  description?: { text: string; bullets: string[] };
  keySkills?: string[];
};

/** Keyed by candidate UI slug. */
export const ADMIN_ROLES: Record<string, AdminFixtureRole> = {
  'customer-support-associate': {
    title: 'Customer Support Associate',
    seniority: 'entry',
  },
  'junior-data-analyst': { title: 'Junior Data Analyst', seniority: 'junior' },
  'sales-development-rep': {
    title: 'Sales Development Rep',
    seniority: 'entry',
    description: {
      text: 'Sales Development Reps start conversations with potential customers. They research accounts, reach out by phone and email, qualify interest and hand warm leads to account executives.',
      bullets: [
        'Research target accounts and the right contacts',
        'Run first calls and handle early objections',
        'Qualify interest and book meetings for account executives',
        'Keep every activity up to date in the CRM',
      ],
    },
    keySkills: [
      'Prospecting',
      'Cold calling',
      'Objection handling',
      'Active listening',
      'CRM hygiene',
    ],
  },
};

export type FixtureRubric = {
  keyPoints: { point: string; example: string }[];
  redFlags: string[];
  expectedStructure: 'star' | 'problem_solution' | 'free';
};

/** Admin fixture rubrics, matched to a seeded question when its text starts with `textPrefix`. */
export const ADMIN_RUBRICS: {
  roleSlug: string;
  textPrefix: string;
  rubric: FixtureRubric;
}[] = [
  {
    roleSlug: 'customer-support-associate',
    textPrefix: 'Tell me about a time you handled an upset customer.',
    rubric: {
      keyPoints: [
        {
          point: 'Acknowledges how the customer feels',
          example: 'I let her explain everything before I said anything.',
        },
        {
          point: 'Takes ownership of the problem',
          example: 'I told him I’d stay with it until it was fixed.',
        },
        {
          point: 'Explains the concrete steps taken',
          example: 'I checked the order history and found the delay.',
        },
        {
          point: 'States the outcome and follow-up',
          example: 'I called back the next day to confirm it arrived.',
        },
      ],
      redFlags: [
        'Blames the customer or colleagues',
        'No clear outcome',
        'Promises something outside policy',
      ],
      expectedStructure: 'star',
    },
  },
];

export const ADMIN_USERS: {
  email: string;
  name: string;
  title: string | null;
  role: 'admin' | 'super_admin';
}[] = [
  {
    email: 'arjun@company.com',
    name: 'Arjun Mehta',
    title: 'Recruitment trainer',
    role: 'super_admin',
  },
  {
    email: 'kavya@company.com',
    name: 'Kavya Menon',
    title: null,
    role: 'admin',
  },
  { email: 'rohan@company.com', name: 'Rohan Das', title: null, role: 'admin' },
];

export const SYSTEM_SAVED_FILTERS: {
  label: string;
  query: Record<string, unknown>;
  isDefault: boolean;
}[] = [
  { label: 'All candidates', query: {}, isDefault: true },
  { label: 'Not ready yet', query: { bands: ['not_ready'] }, isDefault: false },
  {
    label: 'No change in 2 sessions',
    query: { noChangeInSessions: 2 },
    isDefault: false,
  },
  {
    label: 'Invite pending',
    query: { statuses: ['invite_pending'] },
    isDefault: false,
  },
];

/** The admin fixture's workspaceSettings (option lists dropped: they are UI constants). */
export const ADMIN_WORKSPACE_SETTINGS = {
  voice: 'Calm, mid-pitch',
  feedbackLength: 'standard',
  language: 'en',
  audioRetentionDays: 30,
  transcriptRetention: '12m',
  candidatesCanDeleteData: true,
  senderName: 'PrepPilot for [Company]',
  replyTo: '[reply-to@company.com]',
  inviteLinkExpiryDays: 7,
  lastExportAt: null,
} as const;

export const DEFAULT_ROLE_SETTINGS = {
  questionsPerSession: 5,
  questionOrder: 'fixed',
  answerGuideSeconds: 120,
  requireAllCards: true,
  maxSessionsPerCandidate: 5,
  sessionWeights: { firstTry: 20, secondTry: 55, learning: 25 },
  dimensionWeights: { content: 45, structure: 20, delivery: 20, relevance: 15 },
};
