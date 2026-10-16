// Load-test accounts, written straight into the isolated load database. Auth sessions are inserted
// exactly as AuthService.login creates them: the cookie holds a random token, the row holds its sha256.
// No product hook is involved, so this only works with direct DB access.
import pg from 'pg';
import { randomToken, sha256Hex } from '../../src/common/crypto.js';

export type SeededRun = {
  roleId: string;
  roleSlug: string;
  /** One per virtual candidate session: the `pp_session` cookie value and its user id. */
  candidates: { userId: string; token: string }[];
};

/** Columns are TIMESTAMP(3) in UTC (Prisma's convention), whatever the server time zone is. */
const NOW_UTC = "timezone('utc', now())";

/** The database must be a dedicated load DB: its name has to end in `_load`. */
export function assertLoadDatabase(databaseUrl: string): void {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!name.endsWith('_load'))
    throw new Error(
      `Refusing to seed database "${name}": the load test only writes to a database named *_load`,
    );
}

/**
 * Creates `count` active candidates assigned to an approved role with enough approved questions,
 * marks every approved card viewed (requireAllCards), and gives each a fresh auth session.
 */
export async function seedCandidates(
  databaseUrl: string,
  opts: { runId: string; count: number; roleSlug?: string },
): Promise<SeededRun> {
  assertLoadDatabase(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query<{ id: string; slug: string }>(
      `SELECT r.id, r.slug FROM job_roles r
       WHERE r.status = 'approved' AND ($1::text IS NULL OR r.slug = $1)
         AND (SELECT count(*) FROM questions q WHERE q.job_role_id = r.id AND q.status = 'approved')
             >= COALESCE((r.settings->>'questionsPerSession')::int, 5)
       ORDER BY r.slug LIMIT 1`,
      [opts.roleSlug ?? null],
    );
    if (!role.rows[0])
      throw new Error(
        `No approved role${opts.roleSlug ? ` "${opts.roleSlug}"` : ''} with enough approved questions; run the seed first`,
      );
    const { id: roleId, slug: roleSlug } = role.rows[0];

    const users = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, name, role, status, first_login_at, last_active_at, updated_at)
       SELECT gen_random_uuid(), format('load-%s-%s@load.preppilot.test', $1::text, i),
              format('Load Candidate %s', i), 'candidate', 'active', ${NOW_UTC}, ${NOW_UTC}, ${NOW_UTC}
       FROM generate_series(1, $2::int) AS i
       RETURNING id`,
      [opts.runId, opts.count],
    );
    const userIds = users.rows.map((r) => r.id);

    await client.query(
      `INSERT INTO role_assignments (id, user_id, job_role_id, updated_at)
       SELECT gen_random_uuid(), u, $2::uuid, ${NOW_UTC} FROM unnest($1::uuid[]) AS u`,
      [userIds, roleId],
    );
    await client.query(
      `INSERT INTO card_views (user_id, flash_card_id)
       SELECT u, c.id FROM unnest($1::uuid[]) AS u
       CROSS JOIN flash_cards c WHERE c.job_role_id = $2::uuid AND c.status = 'approved'`,
      [userIds, roleId],
    );

    const tokens = userIds.map(() => randomToken());
    await client.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, last_seen_at, expires_at)
       SELECT gen_random_uuid(), t.u, t.h, ${NOW_UTC}, ${NOW_UTC} + interval '1 day'
       FROM unnest($1::uuid[], $2::text[]) AS t(u, h)`,
      [userIds, tokens.map(sha256Hex)],
    );
    await client.query('COMMIT');
    return {
      roleId,
      roleSlug,
      candidates: userIds.map((userId, i) => ({ userId, token: tokens[i] })),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** Attempt and session statuses for the run's users, for the lost-attempt check. */
export async function runOutcome(
  databaseUrl: string,
  userIds: string[],
): Promise<{
  attempts: Record<string, number>;
  sessions: Record<string, number>;
}> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const count = async (sql: string) => {
      const { rows } = await client.query<{ status: string; n: number }>(sql, [
        userIds,
      ]);
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    };
    return {
      attempts: await count(
        `SELECT a.status::text AS status, count(*) AS n FROM attempts a
         JOIN sessions s ON s.id = a.session_id WHERE s.user_id = ANY($1::uuid[]) GROUP BY 1`,
      ),
      sessions: await count(
        `SELECT status::text AS status, count(*) AS n FROM sessions
         WHERE user_id = ANY($1::uuid[]) GROUP BY 1`,
      ),
    };
  } finally {
    await client.end();
  }
}
