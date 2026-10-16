import { AppError } from '../errors/app-error.js';
import {
  decodeKeyset,
  encodeKeyset,
  keysetPage,
  keysetWhere,
  paginationQuerySchema,
} from './pagination.js';

const ID = '6f1c2b8e-1d2a-4c3b-9a4e-5f6a7b8c9d0e';
const AT = new Date('2026-10-14T10:00:00.123Z');
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('pagination', () => {
  it('parses query defaults and bounds', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 200 });
    expect(paginationQuerySchema.parse({ limit: '50', cursor: 'x' })).toEqual({
      limit: 50,
      cursor: 'x',
    });
    expect(paginationQuerySchema.safeParse({ limit: '501' }).success).toBe(
      false,
    );
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('round-trips keyset cursors as opaque base64url', () => {
    const cursor = encodeKeyset({ at: AT, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeKeyset(cursor)).toEqual({ at: AT, id: ID });
    expect(decodeKeyset(undefined)).toBeNull();
    expect(decodeKeyset('')).toBeNull();
  });

  it.each([
    ['garbage', 'garbage'],
    ['an old offset cursor', b64('o:10')],
    ['a bad date', b64(JSON.stringify({ at: 'yesterday', id: ID }))],
    ['a non-uuid id', b64(JSON.stringify({ at: AT.toISOString(), id: 'x' }))],
    ['a missing field', b64(JSON.stringify({ at: AT.toISOString() }))],
  ])('rejects %s with a 400', (_, cursor) => {
    try {
      decodeKeyset(cursor);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: 'validation_failed',
        status: 400,
        message: 'cursor: Invalid cursor',
      });
    }
  });

  it('builds the "strictly after" where on the given timestamp field', () => {
    expect(keysetWhere('createdAt', undefined)).toBeUndefined();
    expect(keysetWhere('createdAt', encodeKeyset({ at: AT, id: ID }))).toEqual({
      OR: [{ createdAt: { lt: AT } }, { createdAt: AT, id: { lt: ID } }],
    });
    expect(() => keysetWhere('at', 'garbage')).toThrow(AppError);
  });

  it('emits nextCursor from the last kept row only while more rows remain', () => {
    const rows = [1, 2, 3].map((n) => ({
      at: new Date(AT.getTime() - n),
      id: `${ID.slice(0, -1)}${n}`,
    }));
    const full = keysetPage(rows, 2, (r) => r);
    expect(full.rows).toEqual(rows.slice(0, 2));
    expect(decodeKeyset(full.nextCursor)).toEqual(rows[1]);
    expect(keysetPage(rows.slice(0, 2), 2, (r) => r)).toEqual({
      rows: rows.slice(0, 2),
      nextCursor: null,
    });
    expect(keysetPage([], 2, (r) => r)).toEqual({ rows: [], nextCursor: null });
  });
});
