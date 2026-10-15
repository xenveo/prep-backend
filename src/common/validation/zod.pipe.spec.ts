import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { ZodPipe } from './zod.pipe.js';

describe('ZodPipe', () => {
  const pipe = new ZodPipe(
    z.object({ email: z.email(), n: z.coerce.number().int().default(1) }),
  );

  it('returns parsed data', () => {
    expect(pipe.transform({ email: 'a@b.co' })).toEqual({
      email: 'a@b.co',
      n: 1,
    });
  });

  it('throws 400 validation_failed naming the field', () => {
    try {
      pipe.transform({ email: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(400);
      expect((e as AppError).code).toBe('validation_failed');
      expect((e as AppError).message).toMatch(/^email:/);
      expect((e as AppError).message).not.toContain('nope');
    }
  });
});
