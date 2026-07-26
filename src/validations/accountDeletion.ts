import { z } from 'zod';

const emptyToUndefined = (v: unknown) => {
  if (v === '' || v === null || v === undefined) return undefined;
  return v;
};

export const createAccountDeletionRequestSchema = z.object({
  body: z
    .object({
      fullName: z.string().trim().min(1, 'Full name is required').max(100),
      email: z.preprocess(
        emptyToUndefined,
        z.string().trim().max(191).email('Invalid email format').optional()
      ),
      phone: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
      accountType: z.enum(['member', 'trainer', 'other']),
      gymName: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
      reason: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
      source: z.enum(['web', 'app']).optional().default('web'),
    })
    .refine(
      (data) => Boolean(data.email?.trim()) || Boolean(data.phone?.trim()),
      {
        message: 'Provide at least an email or a phone number',
        path: ['email'],
      }
    ),
});

export const listAccountDeletionRequestsSchema = z.object({
  query: z.object({
    status: z
      .enum(['pending', 'in_progress', 'completed', 'rejected', 'cancelled'])
      .optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    search: z.string().max(100).optional(),
  }),
});

export const getAccountDeletionRequestSchema = z.object({
  params: z.object({
    id: z.string().min(1).max(40),
  }),
});

export const updateAccountDeletionRequestSchema = z.object({
  params: z.object({
    id: z.string().min(1).max(40),
  }),
  body: z.object({
    status: z
      .enum(['pending', 'in_progress', 'completed', 'rejected', 'cancelled'])
      .optional(),
    processorNotes: z.string().max(5000).optional().nullable(),
    processDeletion: z.boolean().optional(),
    matchedMemberId: z.coerce.number().int().positive().optional().nullable(),
    matchedTrainerId: z.coerce.number().int().positive().optional().nullable(),
    matchedGymId: z.coerce.number().int().positive().optional().nullable(),
  }),
});

export const mobileDeleteAccountSchema = z.object({
  body: z
    .object({
      reason: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
    })
    .optional()
    .default({}),
});
