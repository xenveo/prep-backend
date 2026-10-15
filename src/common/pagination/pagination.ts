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

export const encodeCursor = (offset: number): string =>
  Buffer.from(`o:${offset}`).toString('base64url');

/** Opaque cursor → row offset. Missing cursor = 0; a malformed one is a 400. */
export function decodeCursor(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  const match = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) throw validationFailed('cursor: Invalid cursor');
  return Number(match[1]);
}

/** `rows` is the page already fetched with `skip: decodeCursor(cursor), take: limit`. */
export function paginate<T>(
  rows: T[],
  total: number,
  cursor: string | undefined | null,
  limit: number,
): Page<T> {
  const next = decodeCursor(cursor) + rows.length;
  return {
    rows,
    nextCursor:
      rows.length === limit && next < total ? encodeCursor(next) : null,
    total,
  };
}
