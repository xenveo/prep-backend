import { z } from 'zod';
import { validationFailed } from '../errors/app-error.js';

export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 500;

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export type Page<T> = { rows: T[]; nextCursor: string | null; total: number };

/** The last row of a page in a `[{ <ts>: 'desc' }, { id: 'desc' }]` ordering. */
export type KeysetPosition = { at: Date; id: string };

const keysetSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });

export const encodeKeyset = ({ at, id }: KeysetPosition): string =>
  Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString(
    'base64url',
  );

/** Opaque cursor → keyset position. Missing cursor = first page; a malformed one is a 400. */
export function decodeKeyset(
  cursor: string | undefined | null,
): KeysetPosition | null {
  if (!cursor) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw validationFailed('cursor: Invalid cursor');
  }
  const result = keysetSchema.safeParse(parsed);
  if (!result.success) throw validationFailed('cursor: Invalid cursor');
  return { at: new Date(result.data.at), id: result.data.id };
}

type KeysetWhere<K extends string> = {
  OR: [Record<K, { lt: Date }>, Record<K, Date> & { id: { lt: string } }];
};

/**
 * Rows strictly after the cursor in `[{ <field>: 'desc' }, { id: 'desc' }]` order, to AND onto the
 * list's filters; undefined on the first page. Fetch `take: limit + 1` and pass the rows to `keysetPage`.
 */
export function keysetWhere<K extends string>(
  field: K,
  cursor: string | undefined | null,
): KeysetWhere<K> | undefined {
  const after = decodeKeyset(cursor);
  if (!after) return undefined;
  return {
    OR: [
      { [field]: { lt: after.at } } as Record<K, { lt: Date }>,
      { [field]: after.at, id: { lt: after.id } } as Record<K, Date> & {
        id: { lt: string };
      },
    ],
  };
}

/** Trims the `limit + 1` rows fetched to one page; nextCursor points past its last row when more exist. */
export function keysetPage<T>(
  rows: T[],
  limit: number,
  position: (row: T) => KeysetPosition,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: encodeKeyset(position(page[limit - 1])) };
}
