// Request schemas and response shapes for admin user management (spec "Admin API": "Me and
// candidates", "Workspace settings, admins, audit"). Shapes follow prep-admin-ui src/lib/types.ts.
import { z } from 'zod';

const MAX_IDS = 1000;
const MAX_INVITE_ROWS = 2000;

/** Postgres uuid text (any version), so a malformed id is a 400 instead of a database error. */
export const idSchema = z.guid();
const ids = z.array(idSchema).min(1).max(MAX_IDS);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

/**
 * "Access until": a date from the invite modal (`YYYY-MM-DD`, access ends after that day, UTC) or an
 * ISO date-time. null clears it.
 */
export const accessUntilSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((v) =>
    v.length === 10 ? new Date(`${v}T23:59:59.999Z`) : new Date(v),
  )
  .nullable();

const maxSessions = z.number().int().min(1).max(1000).nullable();

// Invites --------------------------------------------------------------------------------------

export const inviteRowInputSchema = z.object({
  email: z.string().max(320),
  name: z.string().max(200),
  roles: z.array(z.string().max(200)).max(50),
});
export type InviteRowInput = z.infer<typeof inviteRowInputSchema>;

export const validateInvitesSchema = z.object({
  rows: z.array(inviteRowInputSchema).max(MAX_INVITE_ROWS),
});
export type ValidateInvitesBody = z.infer<typeof validateInvitesSchema>;

export const inviteBatchSchema = z.object({
  source: z.enum(['single', 'csv']),
  fileName: z.string().trim().max(255).optional(),
  rows: z
    .array(
      z.object({
        email: z.string().max(320),
        name: z.string().max(200),
        roleIds: z.array(z.string().max(64)).max(50),
      }),
    )
    .min(1)
    .max(MAX_INVITE_ROWS),
  accessUntil: accessUntilSchema.optional(),
  maxSessions: maxSessions.optional(),
});
export type InviteBatchBody = z.infer<typeof inviteBatchSchema>;

export const resendInvitesSchema = z.object({ candidateIds: ids });
export type ResendInvitesBody = z.infer<typeof resendInvitesSchema>;

export type InviteResult =
  | 'ready'
  | 'already_invited'
  | 'invalid_email'
  | 'unknown_role'
  | 'role_not_approved'
  | 'duplicate_in_file';

export type InviteRow = {
  rowNumber: number;
  email: string;
  name: string;
  roles: string[];
  result: InviteResult;
  problemCell?: 'email' | 'roles';
  badRole?: string;
};

export type InviteSummary = {
  total: number;
  ready: number;
  needFixing: number;
};

export type InviteContext = {
  approvedRoleNames: string[];
  draftRoleNames: string[];
  existingEmails: string[];
};

export type InviteBatchResult = {
  batchId: string;
  sent: number;
  skipped: number;
  candidateIds: string[];
};

// Candidates -----------------------------------------------------------------------------------

export const idsSchema = z.object({ ids });
export type IdsBody = z.infer<typeof idsSchema>;

export const updateCandidateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    accessUntil: accessUntilSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.accessUntil !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateCandidateBody = z.infer<typeof updateCandidateSchema>;

export const assignRolesSchema = z.object({
  ids,
  roleIds: z.array(idSchema).min(1).max(50),
});
export type AssignRolesBody = z.infer<typeof assignRolesSchema>;

export const updateAssignmentSchema = z.object({ maxSessions });
export type UpdateAssignmentBody = z.infer<typeof updateAssignmentSchema>;

// Saved filters ---------------------------------------------------------------------------------

/** The admin UI's CandidateQuery (admin band ids). */
export const candidateQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    roleIds: z.array(z.string().max(64)).max(100).optional(),
    bands: z
      .array(z.enum(['not_ready', 'developing', 'nearly', 'ready']))
      .optional(),
    statuses: z
      .array(z.enum(['invite_pending', 'active', 'deactivated', 'revoked']))
      .optional(),
    lastActiveWithinDays: z.number().int().min(0).max(3650).optional(),
    noChangeInSessions: z.number().int().min(0).max(1000).optional(),
    sort: z
      .object({
        columnId: z.enum([
          'name',
          'status',
          'sessions',
          'score',
          'change',
          'lastActive',
        ]),
        direction: z.enum(['asc', 'desc']),
      })
      .optional(),
  })
  .strict();

export const saveFilterSchema = z.object({
  label: z.string().max(100),
  query: candidateQuerySchema,
});
export type SaveFilterBody = z.infer<typeof saveFilterSchema>;

export type SavedFilter = {
  id: string;
  label: string;
  /** The owner; null for system filters. Only the owner can delete a filter. */
  adminId: string | null;
  query: z.infer<typeof candidateQuerySchema>;
  isDefault?: boolean;
};

// Admins ---------------------------------------------------------------------------------------

const adminAccess = z.enum(['admin', 'super_admin']);

export const inviteAdminSchema = z.object({
  email: emailSchema,
  access: adminAccess,
});
export type InviteAdminBody = z.infer<typeof inviteAdminSchema>;

export const changeAdminAccessSchema = z.object({ access: adminAccess });
export type ChangeAdminAccessBody = z.infer<typeof changeAdminAccessSchema>;

/** Admin UI `Admin`. */
export type AdminView = {
  id: string;
  name: string | null;
  email: string;
  title?: string;
  access: 'admin' | 'super_admin';
  status: 'invite_pending' | 'active';
  lastActiveAt: string | null;
  invitedAt?: string;
};
