import { z } from 'zod';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const logoUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine(
    (u) => /^https?:\/\//i.test(u),
    'logoUrl must be http or https'
  )
  .optional()
  .nullable();

export const platformLoginSchema = z.object({
  body: z.object({
    email: z.string().email().max(191),
    password: z.string().min(1).max(500),
  }),
});

export const platformGymListQuerySchema = z.object({
  query: z.object({
    search: z.string().max(200).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    planId: z.coerce.number().int().positive().optional(),
    dueFrom: ymd.optional(),
    dueTo: ymd.optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    sortBy: z.enum(['name', 'createdAt', 'dueDate']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const platformGymIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const platformCreateGymSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(191),
    slug: z.string().min(2).max(64).regex(slugRegex),
    logoUrl: logoUrlSchema,
    address: z.string().max(500).optional().nullable(),
    city: z.string().max(120).optional().nullable(),
    country: z.string().max(120).optional().nullable(),
    ownerAdmin: z.object({
      name: z.string().min(1).max(191),
      email: z.string().email().max(191),
      phone: z.string().max(40).optional().nullable(),
      password: z.string().min(8).max(128).optional(),
    }),
    planId: z.coerce.number().int().positive(),
    dueDate: ymd,
    isActive: z.boolean().optional().default(true),
  }),
});

export const platformPatchGymSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      name: z.string().min(1).max(191).optional(),
      slug: z.string().min(2).max(64).regex(slugRegex).optional(),
      logoUrl: logoUrlSchema,
      address: z.string().max(500).optional().nullable(),
      city: z.string().max(120).optional().nullable(),
      country: z.string().max(120).optional().nullable(),
      phone: z.string().max(40).optional().nullable(),
      email: z.string().email().max(191).optional().nullable(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' }),
});

export const platformSubscriptionPatchSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      planId: z.coerce.number().int().positive().optional(),
      dueDate: ymd.optional(),
      markPaidAt: ymd.optional(),
      notes: z.string().max(2000).optional().nullable(),
    })
    .refine(
      (b) =>
        b.planId !== undefined ||
        b.dueDate !== undefined ||
        b.markPaidAt !== undefined ||
        b.notes !== undefined,
      { message: 'At least one of planId, dueDate, markPaidAt, notes is required' }
    ),
});

export const platformBillingDuesQuerySchema = z.object({
  query: z.object({
    overdue: z.enum(['true', 'false']).optional(),
    dueInDays: z.coerce.number().int().min(0).max(365).optional(),
    planId: z.coerce.number().int().positive().optional(),
    status: z.enum(['ACTIVE', 'TRIAL', 'PAST_DUE', 'CANCELLED']).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  }),
});

export const platformReportsSummaryQuerySchema = z
  .object({
    query: z.object({
      startDate: ymd,
      endDate: ymd,
    }),
  })
  .refine((o) => o.query.startDate <= o.query.endDate, {
    message: 'startDate must be on or before endDate',
    path: ['query', 'endDate'],
  });

export const platformAuditLogsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    actionType: z.string().max(64).optional(),
    targetGymId: z.coerce.number().int().positive().optional(),
  }),
});

export const platformTopMembersQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  }),
});
