import { AppError } from '../../common/errors/app-error.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import {
  candidateExportBodySchema,
  candidateExportSchema,
  candidateQuerySchema,
  reportQuerySchema,
  UuidParamPipe,
} from './reports.schemas.js';

const A = '0b8f7d1e-6c2a-4f1e-9a52-3d6c1b2a4e5f';
const B = '1c9a8e2f-7d3b-4a2f-8b63-4e7d2c3b5f6a';

describe('candidateQuerySchema', () => {
  const parse = (q: unknown) => new ZodPipe(candidateQuerySchema).transform(q);

  it('accepts single, repeated and bracketed list params', () => {
    expect(parse({ roleIds: A }).roleIds).toEqual([A]);
    expect(parse({ roleIds: [A, B] }).roleIds).toEqual([A, B]);
    expect(parse({ 'roleIds[]': A, roleIds: B }).roleIds).toEqual([B, A]);
    expect(parse({ 'bands[]': ['ready', 'nearly'] }).bands).toEqual([
      'ready',
      'nearly',
    ]);
  });

  it('coerces numbers and reads sort and dir', () => {
    expect(
      parse({
        lastActiveWithinDays: '7',
        noChangeInSessions: '2',
        sort: 'score',
        dir: 'asc',
      }),
    ).toEqual({
      lastActiveWithinDays: 7,
      noChangeInSessions: 2,
      sort: 'score',
      dir: 'asc',
    });
    expect(parse({})).toEqual({});
  });

  it('rejects unknown values with 400', () => {
    for (const q of [
      { bands: 'nope' },
      { sort: 'email' },
      { roleIds: 'x' },
      { lastActiveWithinDays: 'a' },
    ]) {
      expect(() => parse(q)).toThrow(AppError);
    }
  });
});

describe('candidateExportSchema', () => {
  it('reads ids in any list form', () => {
    expect(candidateExportSchema.parse({ 'ids[]': [A, B] })).toEqual({
      ids: [A, B],
    });
    expect(candidateExportSchema.parse({})).toEqual({});
  });
});

describe('candidateExportBodySchema', () => {
  const parse = (b: unknown) =>
    new ZodPipe(candidateExportBodySchema).transform(b);

  it('dedupes ids', () => {
    expect(parse({ ids: [A, B, A] })).toEqual({ ids: [A, B] });
  });

  it('rejects a missing, empty, malformed or oversized list with 400', () => {
    const many = Array.from({ length: 5001 }, () => A);
    for (const b of [
      {},
      { ids: [] },
      { ids: ['x'] },
      { ids: A },
      { ids: many },
    ]) {
      expect(() => parse(b)).toThrow(AppError);
    }
    expect(parse({ ids: many.slice(0, 5000) })).toEqual({ ids: [A] });
  });
});

describe('reportQuerySchema', () => {
  it('defaults dateBasis to completed and checks the range', () => {
    expect(reportQuerySchema.parse({ roleId: A })).toEqual({
      roleId: A,
      dateBasis: 'completed',
    });
    expect(
      reportQuerySchema.safeParse({
        roleId: A,
        from: '2026-10-02',
        to: '2026-10-01',
      }).success,
    ).toBe(false);
    expect(
      reportQuerySchema.safeParse({ roleId: A, from: '2026-13-40' }).success,
    ).toBe(false);
    expect(
      reportQuerySchema.safeParse({ roleId: A, dateBasis: 'x' }).success,
    ).toBe(false);
  });
});

describe('UuidParamPipe', () => {
  it('turns a malformed id into 404', () => {
    expect(new UuidParamPipe().transform(A)).toBe(A);
    try {
      new UuidParamPipe().transform('export.csv');
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });
});
