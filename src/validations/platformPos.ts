import { z } from 'zod';
import { POS_PRODUCT_FORMS, POS_PRODUCT_TYPES } from '../services/pos/posHelpers';

const productTypeSchema = z.enum(POS_PRODUCT_TYPES);
const productFormSchema = z.enum(POS_PRODUCT_FORMS);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);

export const platformPosCategoryCreateSchema = z.object({
  body: z.object({
    productType: productTypeSchema,
    name: z.string().trim().min(1).max(128),
    code: z.string().trim().max(64).optional().nullable(),
    description: z.string().trim().max(5000).optional().nullable(),
    sortOrder: nonNegativeInt.optional(),
    isActive: z.boolean().optional(),
  }),
});

export const platformPosCategoryPatchSchema = z.object({
  params: z.object({ id: positiveInt }),
  body: z.object({
    name: z.string().trim().min(1).max(128).optional(),
    code: z.string().trim().max(64).optional().nullable(),
    description: z.string().trim().max(5000).optional().nullable(),
    sortOrder: nonNegativeInt.optional(),
    isActive: z.boolean().optional(),
  }),
});

export const platformPosCategoryIdParamSchema = z.object({
  params: z.object({ id: positiveInt }),
});

export const platformPosSubcategoryCreateSchema = z.object({
  body: z.object({
    categoryId: positiveInt,
    name: z.string().trim().min(1).max(128),
    code: z.string().trim().max(64).optional().nullable(),
    description: z.string().trim().max(5000).optional().nullable(),
    allowedForms: z.array(productFormSchema).optional().nullable(),
    sortOrder: nonNegativeInt.optional(),
    isActive: z.boolean().optional(),
  }),
});

export const platformPosSubcategoryPatchSchema = z.object({
  params: z.object({ id: positiveInt }),
  body: z.object({
    name: z.string().trim().min(1).max(128).optional(),
    code: z.string().trim().max(64).optional().nullable(),
    description: z.string().trim().max(5000).optional().nullable(),
    allowedForms: z.array(productFormSchema).optional().nullable(),
    sortOrder: nonNegativeInt.optional(),
    isActive: z.boolean().optional(),
  }),
});

export const platformPosSubcategoryIdParamSchema = z.object({
  params: z.object({ id: positiveInt }),
});

export const platformPosCatalogQuerySchema = z.object({
  query: z.object({
    productType: productTypeSchema.optional(),
    includeInactive: z.enum(['true', 'false']).optional(),
  }),
});

export const platformPosAnalyticsQuerySchema = z.object({
  query: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    gymId: positiveInt.optional(),
    productType: productTypeSchema.optional(),
    categoryId: positiveInt.optional(),
    subcategoryId: positiveInt.optional(),
    groupBy: z.enum(['gym', 'day', 'category', 'subcategory', 'product']).default('day'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});
