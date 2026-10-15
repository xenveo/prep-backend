import { notFound } from '../../common/errors/app-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can't match a uuid row: 404 here instead of a database error. */
export function requireUuid(id: string, message: string): string {
  if (!UUID.test(id)) throw notFound(message);
  return id;
}
