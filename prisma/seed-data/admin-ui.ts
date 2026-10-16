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

/**
 * Rubrics matched to a seeded question when its text starts with `textPrefix`, in place of the one
 * derived from its linked card. The first is the admin fixture's; the rest are seed-only, for
 * questions no flash card covers.
 */
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
  {
    // Linked to the closest card ("report by tomorrow but the data is incomplete"), which is about
    // missing data, not prioritising.
    roleSlug: 'junior-data-analyst',
    textPrefix:
      'How do you decide what to do first when several requests arrive at once?',
    rubric: {
      keyPoints: [
        {
          point: 'Finds out each request’s deadline and what it is for',
          example: 'I asked each person when they needed it and why.',
        },
        {
          point: 'Ranks by impact and urgency, not by who asked first',
          example:
            'The board figures went first because the meeting was next morning.',
        },
        {
          point: 'Tells each requester when to expect their work',
          example: 'I let the others know theirs would follow on Thursday.',
        },
        {
          point: 'Asks a manager to decide when priorities clash',
          example: 'Two urgent asks clashed, so I checked with my manager.',
        },
      ],
      redFlags: [
        'Works first come, first served without weighing impact',
        'Says yes to everything and misses deadlines without warning',
        'Leaves requesters with no update',
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
