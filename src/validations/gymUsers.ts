import { z } from 'zod';

const gymRole = z.enum(['GYM_ADMIN', 'GYM_MANAGER', 'GYM_STAFF']);

export const gymUserIdParamSchema = z.object({
  params: z.object({
    id: z
      .string()
      .regex(/^\d+$/, 'id must be a number')
      .transform((v) => parseInt(v, 10)),
  }),
});

export const gymUserListQuerySchema = z.object({
  query: z.object({}).optional(),
});

export const gymUserCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    email: z.string().email('Invalid email format'),
    phone: z.string().max(64).optional().nullable(),
    role: gymRole,
    password: z
      .preprocess(
        (v) => (v === '' || v === undefined ? null : v),
        z
          .string()
          .min(8, 'Password must be at least 8 characters')
          .nullable()
          .optional()
      )
      .optional(),
  }),
});

export const gymUserPatchSchema = z.object({
  params: z.object({
    id: z
      .string()
      .regex(/^\d+$/, 'id must be a number')
      .transform((v) => parseInt(v, 10)),
  }),
  body: z
    .object({
      name: z.string().min(1).max(255).optional(),
      email: z.string().email('Invalid email format').optional(),
      phone: z.string().max(64).optional().nullable(),
      role: gymRole.optional(),
      isActive: z.boolean().optional(),
      password: z
        .preprocess(
          (v) => (v === '' || v === undefined ? null : v),
          z
            .string()
            .min(8, 'Password must be at least 8 characters')
            .nullable()
            .optional()
        )
        .optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' }),
});
