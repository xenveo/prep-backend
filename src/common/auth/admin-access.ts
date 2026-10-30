import type { Prisma, User } from '../../generated/prisma/client.js';

export type AdminAccess = 'admin' | 'super_admin';

export const ADMIN_ACCESS: AdminAccess[] = ['admin', 'super_admin'];

/**
 * A user's admin access: an admin account's `role`, or a candidate's `adminRole` (a candidate who is
 * also an admin keeps `role: candidate` so their sessions still count as a candidate's). Null when
 * the user has no admin access.
 */
export function adminAccessOf(
  user: Pick<User, 'role' | 'adminRole'>,
): AdminAccess | null {
  if (user.role === 'admin' || user.role === 'super_admin') return user.role;
  if (user.adminRole === 'admin' || user.adminRole === 'super_admin')
    return user.adminRole;
  return null;
}

/** Users whose admin access (see adminAccessOf) is one of `access`. */
export function hasAdminAccess(
  access: AdminAccess[] = ADMIN_ACCESS,
): Prisma.UserWhereInput {
  return {
    OR: [
      { role: { in: access } },
      { role: 'candidate', adminRole: { in: access } },
    ],
  };
}
