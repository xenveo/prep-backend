import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validationFailed } from '../errors/app-error.js';

/** Builds a short, user-safe message from Zod issues (paths and messages, never the input). */
export function formatZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) =>
      i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
    )
    .join('; ');
}

/** Usage: `@Body(new ZodPipe(schema)) body: z.infer<typeof schema>`. Throws 400 validation_failed. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success)
      throw validationFailed(formatZodIssues(parsed.error.issues));
    return parsed.data;
  }
}
