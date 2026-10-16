import type { IncomingHttpHeaders } from 'node:http';
import { SESSION_COOKIE } from './auth.types.js';

/** The admin app's login cookie; the candidate app keeps `pp_session`. */
export const ADMIN_SESSION_COOKIE = 'pp_admin_session';

/** Sent by the admin app's server rendering, whose requests carry no Origin or Referer. */
export const APP_HEADER = 'x-preppilot-app';

const originOf = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/**
 * The login cookie a request uses. Both apps share the parent-domain cookie jar
 * (SESSION_COOKIE_DOMAIN), so each has its own cookie: otherwise signing in to one app signs the
 * other out. Browser requests (fetch, WebSocket, <audio>) are told apart by Origin, or by Referer
 * when there is no Origin; the admin app's server rendering sends `X-PrepPilot-App: admin`.
 * Everything else is the candidate app. Choosing the cookie grants nothing: it must still be valid.
 */
export function sessionCookieName(
  headers: IncomingHttpHeaders,
  adminOrigin: string,
): string {
  if (headers[APP_HEADER] === 'admin') return ADMIN_SESSION_COOKIE;
  const from = originOf(headers.origin) ?? originOf(headers.referer);
  return from !== null && from === originOf(adminOrigin)
    ? ADMIN_SESSION_COOKIE
    : SESSION_COOKIE;
}
