import type { Request } from 'express';
import type { UserRole, UserStatus } from '../../generated/prisma/client.js';

export const SESSION_COOKIE = 'pp_session';

/** The signed-in user, set on `req.user` by SessionGuard. */
export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  accessExpiresAt: Date | null;
  authSessionId: string;
};

export type AuthedRequest = Request & { user?: AuthUser };
