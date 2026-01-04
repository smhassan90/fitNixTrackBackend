import { z } from 'zod';

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

