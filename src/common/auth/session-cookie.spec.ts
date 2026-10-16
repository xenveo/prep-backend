import { ADMIN_SESSION_COOKIE, sessionCookieName } from './session-cookie.js';

const ADMIN = 'https://prep-admin.xenveo.com';

describe('sessionCookieName', () => {
  it('uses the admin cookie for requests from the admin origin', () => {
    expect(sessionCookieName({ origin: ADMIN }, ADMIN)).toBe(
      ADMIN_SESSION_COOKIE,
    );
  });

  it('falls back to the Referer origin (e.g. <audio> requests, which send no Origin)', () => {
    expect(
      sessionCookieName({ referer: `${ADMIN}/sessions/1?x=1` }, ADMIN),
    ).toBe(ADMIN_SESSION_COOKIE);
  });

  it("uses the admin cookie for the admin app's server rendering header", () => {
    expect(sessionCookieName({ 'x-preppilot-app': 'admin' }, ADMIN)).toBe(
      ADMIN_SESSION_COOKIE,
    );
  });

  it('uses the candidate cookie for everything else', () => {
    expect(
      sessionCookieName({ origin: 'https://prep.xenveo.com' }, ADMIN),
    ).toBe('pp_session');
    expect(sessionCookieName({}, ADMIN)).toBe('pp_session');
    expect(sessionCookieName({ origin: 'null' }, ADMIN)).toBe('pp_session');
    expect(
      sessionCookieName(
        { origin: 'https://prep-admin.xenveo.com.evil.io' },
        ADMIN,
      ),
    ).toBe('pp_session');
  });
});
