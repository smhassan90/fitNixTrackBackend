import { z } from 'zod';

const featureCodeRegex = /^[A-Z0-9_]+$/;

export const createPackageSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    price: z.number().min(0, 'Price must be non-negative'),
    discount: z.number().min(0, 'Discount must be non-negative').optional(),
    duration: z.enum(['1 month', '3 months', '6 months', '12 months'], {
      errorMap: () => ({ message: 'Duration must be one of: 1 month, 3 months, 6 months, 12 months' }),
    }),
    featureIds: z.array(z.number().int().positive()).min(1, 'At least one feature is required').optional(),
  }),
});

export const updatePackageSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Package ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    price: z.number().min(0).optional(),
    discount: z.number().min(0, 'Discount must be non-negative').optional(),
    duration: z.enum(['1 month', '3 months', '6 months', '12 months']).optional(),
    featureIds: z.array(z.number().int().positive()).optional(),
  }),
});

export const getPackagesSchema = z.object({
  query: z.object({
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
  }),
});

export const getPackageSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Package ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const deletePackageSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Package ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const getPackageFeaturesQuerySchema = z.object({
  query: z.object({
    /** When true, include inactive features (GYM_ADMIN catalog screen). Default: active only. */
    all: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .transform((v) => v === 'true' || v === '1'),
  }),
});

export const createPackageFeatureSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(191),
    code: z.string().min(1).max(64).regex(featureCodeRegex).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.coerce.number().int().optional().default(0),
  }),
});

export const updatePackageFeatureSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)),
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

export const deletePackageFeatureSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)),
  }),
});
