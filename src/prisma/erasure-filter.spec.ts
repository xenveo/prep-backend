import { withErasureWhere } from './erasure-filter.js';

describe('withErasureWhere', () => {
  it('adds deletedAt: null to User reads, keeping unique keys at the top', () => {
    expect(
      withErasureWhere('User', 'findUnique', { where: { id: 'u1' } }),
    ).toEqual({
      where: { id: 'u1', AND: [{ deletedAt: null }] },
    });
  });

  it('handles missing args and where', () => {
    expect(withErasureWhere('User', 'count', undefined)).toEqual({
      where: { AND: [{ deletedAt: null }] },
    });
    expect(withErasureWhere('User', 'findMany', { take: 5 })).toEqual({
      take: 5,
      where: { AND: [{ deletedAt: null }] },
    });
  });

  it('merges with an existing AND (array or object) instead of overwriting', () => {
    expect(
      withErasureWhere('Session', 'findMany', {
        where: { AND: [{ number: 1 }], user: { name: 'x' } },
      }),
    ).toEqual({
      where: {
        user: { name: 'x' },
        AND: [{ number: 1 }, { user: { deletedAt: null } }],
      },
    });
    expect(
      withErasureWhere('Session', 'findFirst', {
        where: { AND: { number: 1 } },
      }),
    ).toEqual({
      where: { AND: [{ number: 1 }, { user: { deletedAt: null } }] },
    });
  });

  it('filters attempts through their session', () => {
    expect(
      withErasureWhere('Attempt', 'groupBy', {
        by: ['status'],
        where: { score: 1 },
      }),
    ).toEqual({
      by: ['status'],
      where: { score: 1, AND: [{ session: { user: { deletedAt: null } } }] },
    });
  });

  it('covers every user-owned model', () => {
    for (const m of [
      'RoleAssignment',
      'CardView',
      'ActivityEvent',
      'Consent',
      'PrivacyRequest',
    ]) {
      expect(withErasureWhere(m, 'aggregate', {})).toEqual({
        where: { AND: [{ user: { deletedAt: null } }] },
      });
    }
  });

  it('leaves writes and other models alone', () => {
    const args = { where: { id: 'u1' }, data: { name: 'x' } };
    expect(withErasureWhere('User', 'update', args)).toBe(args);
    expect(withErasureWhere('JobRole', 'findMany', args)).toBe(args);
    expect(withErasureWhere(undefined, 'findMany', args)).toBe(args);
  });
});
