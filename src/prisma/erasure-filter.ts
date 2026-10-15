// Erasure stage 1 (plan §4): reads hide users with `deletedAt` set, and the rows they own.
// Raw SQL is not filtered: callers join `users` and filter `deleted_at IS NULL` themselves.

const FILTERS: Partial<Record<string, Record<string, unknown>>> = {
  User: { deletedAt: null },
  RoleAssignment: { user: { deletedAt: null } },
  Session: { user: { deletedAt: null } },
  CardView: { user: { deletedAt: null } },
  ActivityEvent: { user: { deletedAt: null } },
  Consent: { user: { deletedAt: null } },
  PrivacyRequest: { user: { deletedAt: null } },
  Attempt: { session: { user: { deletedAt: null } } },
};

const READ_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Returns `args` with the erasure filter ANDed into `where`. The caller's own keys stay at the top
 * level (findUnique needs its unique field there); the filter goes into `AND`.
 */
export function withErasureWhere<A>(
  model: string | undefined,
  operation: string,
  args: A,
): A {
  const filter = model ? FILTERS[model] : undefined;
  if (!filter || !READ_OPERATIONS.has(operation)) return args;
  const a = (args ?? {}) as { where?: Record<string, unknown> };
  const where = a.where ?? {};
  const and =
    where.AND === undefined
      ? []
      : Array.isArray(where.AND)
        ? where.AND
        : [where.AND];
  return { ...a, where: { ...where, AND: [...and, filter] } } as A;
}
