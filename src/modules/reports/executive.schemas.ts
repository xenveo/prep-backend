import { z } from 'zod';

export const executiveQuerySchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM')
    .optional(),
  roleId: z.uuid().optional(),
});
export const executiveCandidatesQuerySchema = executiveQuerySchema.extend({
  recruiterId: z.union([z.uuid(), z.literal('unknown')]).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});
export type ExecutiveQuery = z.output<typeof executiveQuerySchema>;
export type ExecutiveCandidatesQuery = z.output<
  typeof executiveCandidatesQuerySchema
>;
