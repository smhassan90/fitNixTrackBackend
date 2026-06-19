import { z } from 'zod';

export const importQuerySchema = z.object({
  query: z.object({
    dryRun: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    admissionFeeWaived: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v !== 'false'),
    createMissingTrainers: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  }),
});

export const importTemplateSchema = z.object({
  params: z.object({
    type: z.enum(['packages', 'trainers', 'members']),
  }),
});
