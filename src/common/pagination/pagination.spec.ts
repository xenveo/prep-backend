import { AppError } from '../errors/app-error.js';
import {
  decodeCursor,
  encodeCursor,
  paginate,
  paginationQuerySchema,
} from './pagination.js';

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

  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(() => decodeCursor('garbage')).toThrow(AppError);
  });

  it('emits nextCursor only while more rows remain', () => {
    const first = paginate([1, 2], 5, undefined, 2);
    expect(first.total).toBe(5);
    expect(decodeCursor(first.nextCursor)).toBe(2);
    const second = paginate([3, 4], 5, first.nextCursor, 2);
    expect(decodeCursor(second.nextCursor)).toBe(4);
    expect(paginate([5], 5, second.nextCursor, 2).nextCursor).toBeNull();
    expect(paginate([1, 2], 2, undefined, 2).nextCursor).toBeNull();
  });
});
