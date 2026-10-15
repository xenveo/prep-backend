import { z } from 'zod';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const requestCodeSchema = z.object({ email });

export const verifySchema = z.union([
  z.object({
    email,
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  }),
  z.object({ token: z.string().trim().min(16).max(256) }),
]);

export type RequestCodeBody = z.infer<typeof requestCodeSchema>;
export type VerifyBody = z.infer<typeof verifySchema>;

export type RequestCodeResponse =
  { result: 'sent' } | { result: 'rate-limited'; retryAfterSec: number };
export type VerifyResult = 'ok' | 'wrong' | 'expired';

/** Candidate UI `GET /me`. */
export type MeResponse = {
  id: string;
  email: string;
  name: string | null;
  initials: string;
  role: 'candidate' | 'admin' | 'super_admin';
  accessExpiresAt: string | null;
  audioRetentionDays: 7 | 30 | 90;
  candidatesCanDeleteData: boolean;
};

/** Admin UI `Admin` (src/lib/types.ts). */
export type AdminMeResponse = {
  id: string;
  name: string | null;
  email: string;
  title?: string;
  access: 'admin' | 'super_admin';
  status: 'invite_pending' | 'active';
  lastActiveAt: string | null;
  invitedAt?: string;
};
