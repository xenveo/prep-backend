// Workspace settings document (spec "Workspace settings", plan §13). The admin UI's WorkspaceSettings
// plus backend-only fields: erasureGraceDays and the delivery metric targets (NFR-12: config, not code).
import { z } from 'zod';
import type { FieldAuditDef } from '../../common/audit/audit.service.js';

const range = (min: number, max: number, scaleMin: number, scaleMax: number) =>
  z
    .object({
      min: z.number(),
      max: z.number(),
      scaleMin: z.number(),
      scaleMax: z.number(),
    })
    .default({ min, max, scaleMin, scaleMax });

export const deliveryTargetsSchema = z.object({
  pace: range(120, 160, 80, 200),
  fillers: range(0, 4, 0, 12),
  pauses: range(3, 6, 0, 8),
});

export const TRANSCRIPT_RETENTION_LABEL = {
  '6m': '6 months',
  '12m': '12 months',
  until_removed: 'Until the candidate is removed',
} as const;

/** The admin UI's VOICE_OPTIONS. */
export const VOICE_OPTIONS = [
  'Calm, mid-pitch',
  'Warm, lower pitch',
  'Bright, higher pitch',
] as const;

/** Spoken by "Play sample" in the chosen voice. */
export const VOICE_SAMPLE_TEXT =
  "Hi, I'm your PrepPilot interviewer. Take a moment, then tell me about yourself.";

export const workspaceSettingsSchema = z.object({
  voice: z.string().trim().min(1).default('Calm, mid-pitch'),
  feedbackLength: z.enum(['short', 'standard']).default('standard'),
  language: z.literal('en').default('en'),
  audioRetentionDays: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .default(30),
  transcriptRetention: z.enum(['6m', '12m', 'until_removed']).default('12m'),
  candidatesCanDeleteData: z.boolean().default(true),
  senderName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default('PrepPilot for [Company]'),
  /** An email, or a "[placeholder]" until the workspace sets one (as the admin UI allows). */
  replyTo: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || /^\[.*\]$/.test(v) || z.email().safeParse(v).success,
      'Enter a valid reply-to address',
    )
    .default('[reply-to@company.com]'),
  inviteLinkExpiryDays: z.number().int().min(1).max(90).default(7),
  lastExportAt: z.string().nullable().default(null),
  erasureGraceDays: z.number().int().min(0).max(30).default(7),
  deliveryTargets: deliveryTargetsSchema.default({
    pace: { min: 120, max: 160, scaleMin: 80, scaleMax: 200 },
    fillers: { min: 0, max: 4, scaleMin: 0, scaleMax: 12 },
    pauses: { min: 3, max: 6, scaleMin: 0, scaleMax: 8 },
  }),
});

export type WorkspaceSettingsData = z.infer<typeof workspaceSettingsSchema>;
export type DeliveryTargets = WorkspaceSettingsData['deliveryTargets'];

/** The admin UI's WorkspaceSettings: the document without backend-only fields. */
export type AdminWorkspaceSettings = Omit<
  WorkspaceSettingsData,
  'erasureGraceDays' | 'deliveryTargets'
>;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettingsData =
  workspaceSettingsSchema.parse({});

/**
 * PATCH /admin/settings body: any subset of the editable admin fields, without defaults so absent
 * keys stay absent. `language` is fixed and `lastExportAt` is set by exports; both are ignored.
 */
const s = workspaceSettingsSchema.shape;
export const settingsPatchSchema = z.object({
  voice: z.enum(VOICE_OPTIONS).optional(),
  feedbackLength: s.feedbackLength.unwrap().optional(),
  audioRetentionDays: s.audioRetentionDays.unwrap().optional(),
  transcriptRetention: s.transcriptRetention.unwrap().optional(),
  candidatesCanDeleteData: s.candidatesCanDeleteData.unwrap().optional(),
  senderName: s.senderName.unwrap().optional(),
  replyTo: s.replyTo.unwrap().optional(),
  inviteLinkExpiryDays: s.inviteLinkExpiryDays.unwrap().optional(),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Audit actions and value labels per field, exactly as the admin UI logs them (services/settings.ts). */
export const SETTINGS_FIELD_AUDIT: readonly FieldAuditDef<WorkspaceSettingsData>[] =
  [
    { key: 'voice', action: 'Changed interviewer voice' },
    { key: 'feedbackLength', action: 'Changed feedback length' },
    {
      key: 'audioRetentionDays',
      action: 'Changed audio retention',
      show: (v: number) => `${v} days`,
    },
    {
      key: 'transcriptRetention',
      action: 'Changed transcript retention',
      show: (v: keyof typeof TRANSCRIPT_RETENTION_LABEL) =>
        TRANSCRIPT_RETENTION_LABEL[v],
    },
    {
      key: 'candidatesCanDeleteData',
      action: 'Changed candidate data deletion',
      show: (v: boolean) => (v ? 'On' : 'Off'),
    },
    { key: 'senderName', action: 'Changed sender name' },
    { key: 'replyTo', action: 'Changed reply-to address' },
    // Not editable in the admin UI yet, so it has no UI action string.
    {
      key: 'inviteLinkExpiryDays',
      action: 'Changed invite link expiry',
      show: (v: number) => `${v} days`,
    },
  ];
