import { z } from 'zod';
import { KNOWN_PLATFORM_PERMISSION_KEYS } from '../constants/platformPermissions';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Full http(s) URL (e.g. Vercel Blob), or path returned by backend disk upload (`/uploads/logos/...`). */
export const logoUrlSchema = z.preprocess(
  (val) => (val === '' ? undefined : val),
  z
    .union([z.string().max(2048), z.null()])
    .optional()
    .superRefine((val, ctx) => {
      if (val === undefined || val === null) return;
      const ok =
        /^https?:\/\/.+/i.test(val) || /^\/uploads\/logos\/[a-zA-Z0-9._-]+$/i.test(val);
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'logoUrl must be a full http(s) URL or an uploaded path under /uploads/logos/',
        });
      }
    })
);

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
    city: z.string().min(1).max(120),
    country: z.string().min(1).max(120),
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

export const platformLocationCountryCitiesParamsSchema = z.object({
  params: z.object({
    countryId: z.coerce.number().int().positive(),
  }),
});

export const platformLocationCountryCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    code: z.string().min(2).max(10).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.coerce.number().int().optional().default(0),
  }),
});

export const platformLocationCountryPatchSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      name: z.string().min(1).max(120).optional(),
      code: z.string().min(2).max(10).optional().nullable(),
      isActive: z.boolean().optional(),
      sortOrder: z.coerce.number().int().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' }),
});

export const platformLocationCityCreateSchema = z.object({
  body: z.object({
    countryId: z.coerce.number().int().positive(),
    name: z.string().min(1).max(120),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.coerce.number().int().optional().default(0),
  }),
});

export const platformLocationCityPatchSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      countryId: z.coerce.number().int().positive().optional(),
      name: z.string().min(1).max(120).optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.coerce.number().int().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' }),
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

export const platformBillingPlansQuerySchema = z.object({
  query: z.object({
    active: z.enum(['true', 'false']).optional(),
  }),
});

const billingPaymentMethodZ = z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'JAZZCASH', 'EASYPAISA']);

export const platformGymBillingPaymentCreateSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    amountPaid: z.coerce.number().positive(),
    currency: z.string().min(1).max(10),
    paidAt: ymd,
    method: billingPaymentMethodZ,
    notes: z.string().max(2000).optional(),
  }),
});

const gymOwnerAdminBody = z.object({
  name: z.string().min(1).max(191),
  email: z.string().email().max(191),
  phone: z.string().max(40).optional().nullable(),
  password: z.string().min(8).max(128).optional(),
});

export const platformGymOwnerAdminCreateSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: gymOwnerAdminBody,
});

export const platformGymOwnerAdminResetPasswordSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    password: z.string().min(8).max(128).optional(),
  }),
});

export const platformGymOwnerAdminUpdateSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      name: z.string().min(1).max(191).optional(),
      email: z.string().email().max(191).optional(),
      phone: z.string().max(40).optional().nullable(),
      isActive: z.boolean().optional(),
    })
    .refine(
      (body) =>
        body.name !== undefined ||
        body.email !== undefined ||
        body.phone !== undefined ||
        body.isActive !== undefined,
      { message: 'At least one field is required' }
    ),
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

const platformRoleZ = z.enum(['SUPER_ADMIN', 'PLATFORM_SUPPORT']);
const billingPlanCodeRegex = /^[A-Z0-9_]+$/;
const billingCycleZ = z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']);
const featureCodeRegex = /^[A-Z0-9_]+$/;

const permissionKeysBody = z
  .array(z.string().min(1).max(128))
  .optional()
  .superRefine((keys, ctx) => {
    if (!keys) return;
    keys.forEach((k, i) => {
      if (!KNOWN_PLATFORM_PERMISSION_KEYS.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown permission key: ${k}`,
          path: [i],
        });
      }
    });
  });

/** List / filter platform operators (SUPER_ADMIN only — see route). */
export const platformOperatorUsersQuerySchema = z.object({
  query: z.object({
    search: z.string().max(200).optional(),
    role: platformRoleZ.optional(),
    isActive: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
});

export const platformOperatorUserIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const platformOperatorUserCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(191),
    email: z.string().email().max(191),
    password: z.string().min(8).max(128).optional(),
    role: platformRoleZ,
    isActive: z.boolean().optional().default(true),
    permissionKeys: permissionKeysBody,
  }),
});

export const platformOperatorUserPatchSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      name: z.string().min(1).max(191).optional(),
      email: z.string().email().max(191).optional(),
      password: z.string().min(8).max(128).optional(),
      role: platformRoleZ.optional(),
      isActive: z.boolean().optional(),
      permissionKeys: permissionKeysBody,
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' }),
});

export const platformBillingPlanCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(191),
    code: z.string().min(1).max(64).regex(billingPlanCodeRegex),
    description: z.string().max(2000).optional().nullable(),
    price: z.coerce.number().min(0),
    currency: z.string().min(1).max(10),
    billingCycle: billingCycleZ,
    isActive: z.boolean().optional().default(true),
    sortOrder: z.coerce.number().int().optional().default(0),
  }),
});

export const platformBillingPlanPatchSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      name: z.string().min(1).max(191).optional(),
      code: z.string().min(1).max(64).regex(billingPlanCodeRegex).optional(),
      description: z.string().max(2000).optional().nullable(),
      price: z.coerce.number().min(0).optional(),
      currency: z.string().min(1).max(10).optional(),
      billingCycle: billingCycleZ.optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.coerce.number().int().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' }),
});

export const platformBillingPlanDeleteParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const platformPackageFeatureCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(191),
    code: z.string().min(1).max(64).regex(featureCodeRegex).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.coerce.number().int().optional().default(0),
  }),
});

export const platformPackageFeaturePatchSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      name: z.string().min(1).max(191).optional(),
      code: z.string().min(1).max(64).regex(featureCodeRegex).optional().nullable(),
      description: z.string().max(2000).optional().nullable(),
      isActive: z.boolean().optional(),
      sortOrder: z.coerce.number().int().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' }),
});

export const platformPackageFeatureDeleteParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});
