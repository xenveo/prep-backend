// Invite-row checks: the authoritative version of prep-admin-ui src/lib/csv.ts validateInviteInput.
import type {
  InviteResult,
  InviteRow,
  InviteRowInput,
  InviteSummary,
} from './users.schemas.js';

/** Same rule as the admin UI, so the client preview and the server agree. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email.trim());
}

export type InviteValidationContext = {
  approvedRoleNames: Iterable<string>;
  /** Roles that exist but aren't approved yet ("Role not approved yet"). Archived roles count as unknown. */
  draftRoleNames: Iterable<string>;
  /** Emails already in use by a user. */
  existingEmails: Iterable<string>;
};

const lower = (values: Iterable<string>) =>
  new Set(Array.from(values, (v) => v.trim().toLowerCase()));

/**
 * First problem wins, in this order: invalid email, already invited, duplicate in file, unknown role,
 * role not approved. Email and role-name matching is case-insensitive. Rows are numbered from 1.
 */
export function validateInviteRows(
  input: InviteRowInput[],
  ctx: InviteValidationContext,
): InviteRow[] {
  const approved = lower(ctx.approvedRoleNames);
  const drafts = lower(ctx.draftRoleNames);
  const existing = lower(ctx.existingEmails);
  const seen = new Set<string>();

  return input.map((row, index): InviteRow => {
    const email = row.email.trim();
    const key = email.toLowerCase();
    const roles = row.roles.map((r) => r.trim()).filter(Boolean);
    const base = { rowNumber: index + 1, email, name: row.name.trim(), roles };
    const done = (
      result: InviteResult,
      extra: Partial<InviteRow> = {},
    ): InviteRow => ({ ...base, result, ...extra });

    if (!isValidEmail(email))
      return done('invalid_email', { problemCell: 'email' });
    if (existing.has(key)) {
      seen.add(key);
      return done('already_invited', { problemCell: 'email' });
    }
    if (seen.has(key))
      return done('duplicate_in_file', { problemCell: 'email' });
    seen.add(key);

    if (roles.length === 0)
      return done('unknown_role', { problemCell: 'roles', badRole: '' });
    const unknown = roles.find(
      (r) => !approved.has(r.toLowerCase()) && !drafts.has(r.toLowerCase()),
    );
    if (unknown !== undefined)
      return done('unknown_role', { problemCell: 'roles', badRole: unknown });
    const draft = roles.find((r) => !approved.has(r.toLowerCase()));
    if (draft !== undefined)
      return done('role_not_approved', {
        problemCell: 'roles',
        badRole: draft,
      });
    return done('ready');
  });
}

export function summariseInviteRows(rows: InviteRow[]): InviteSummary {
  const ready = rows.filter((r) => r.result === 'ready').length;
  return { total: rows.length, ready, needFixing: rows.length - ready };
}
