// Copied from prep-admin-ui/src/data/sample-data.json and src/services/store.ts (saved filters).
// Placeholder emails like "[arjun@company.com]" are stored without the brackets.

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
