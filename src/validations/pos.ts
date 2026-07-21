import { z } from 'zod';
import {
  POS_DISCOUNT_TYPES,
  POS_PRODUCT_FORMS,
  POS_PRODUCT_TYPES,
} from '../services/pos/posHelpers';

const discountTypeSchema = z.enum(POS_DISCOUNT_TYPES);
const productTypeSchema = z.enum(POS_PRODUCT_TYPES);
const productFormSchema = z.enum(POS_PRODUCT_FORMS);

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);
const nonNegativeFloat = z.coerce.number().min(0);
const optionalTrimmed = z.string().trim().optional().nullable();

const nutrientFieldsSchema = z.object({
  calories: nonNegativeFloat.optional().nullable(),
  proteinG: nonNegativeFloat.optional().nullable(),
  carbsG: nonNegativeFloat.optional().nullable(),
  fatG: nonNegativeFloat.optional().nullable(),
  fiberG: nonNegativeFloat.optional().nullable(),
  sugarG: nonNegativeFloat.optional().nullable(),
  servingSizeG: nonNegativeFloat.optional().nullable(),
  servingLabel: z.string().trim().max(64).optional().nullable(),
});

const accessoryFieldsSchema = z.object({
  material: z.string().trim().max(128).optional().nullable(),
  color: z.string().trim().max(64).optional().nullable(),
  size: z.string().trim().max(64).optional().nullable(),
});

const productBaseSchema = z.object({
  subcategoryId: positiveInt,
  name: z.string().trim().min(1).max(255),
  sku: z.string().trim().max(64).optional().nullable(),
  description: z.string().trim().max(5000).optional().nullable(),
  imageUrl: z.string().trim().url().max(2048).optional().nullable(),
  brand: z.string().trim().max(128).optional().nullable(),
  price: nonNegativeFloat,
  discountType: discountTypeSchema.default('NONE'),
  discountValue: nonNegativeFloat.default(0),
  trackInventory: z.boolean().optional(),
  lowStockThreshold: nonNegativeInt.optional(),
  isActive: z.boolean().optional(),
  initialStock: nonNegativeInt.optional(),
});

export const posGymSubcategoriesPutSchema = z.object({
  body: z.object({
    subcategoryIds: z.array(positiveInt).default([]),
  }),
});

export const posProductCreateSchema = z.object({
  body: productBaseSchema
    .extend({
      productType: productTypeSchema,
      form: productFormSchema.default('PACKAGED'),
    })
    .merge(nutrientFieldsSchema.partial())
    .merge(accessoryFieldsSchema.partial()),
});

export const posProductPatchSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: productBaseSchema
    .partial()
    .extend({
      form: productFormSchema.optional(),
    })
    .merge(nutrientFieldsSchema.partial())
    .merge(accessoryFieldsSchema.partial()),
});

export const posProductIdParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

export const posProductListQuerySchema = z.object({
  query: z.object({
    productType: productTypeSchema.optional(),
    subcategoryId: positiveInt.optional(),
    isActive: z.enum(['true', 'false']).optional(),
    search: z.string().trim().max(255).optional(),
    page: z.coerce.number().int().min(1).default(1),
  /** POS grids often load the full catalog; allow higher than generic list endpoints. */
    limit: z.coerce.number().int().min(1).max(500).default(50),
  }),
});

export const posInventoryRestockSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    quantity: positiveInt,
    note: z.string().trim().max(2000).optional().nullable(),
  }),
});

export const posInventoryAdjustSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    stockQuantity: nonNegativeInt,
    note: z.string().trim().max(2000).optional().nullable(),
  }),
});

export const posSaleCreateSchema = z.object({
  body: z.object({
    memberId: z.union([
      z.coerce.number().int().positive(),
      z.string().trim().min(1),
      z.null(),
    ]).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
    items: z.array(z.object({
      productId: positiveInt,
      quantity: positiveInt,
      discountType: discountTypeSchema.optional(),
      discountValue: nonNegativeFloat.optional(),
    })).min(1).max(50),
  }),
});

export const posSaleIdParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

export const posSaleVoidSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    reason: z.string().trim().min(3).max(2000),
  }),
});

const optionalDateQuery = z
  .string()
  .trim()
  .refine(
    (v) =>
      /^\d{4}-\d{2}-\d{2}$/.test(v)
      || !Number.isNaN(new Date(v).getTime()),
    'Date must be YYYY-MM-DD or ISO datetime'
  )
  .optional();

export const posSalesListQuerySchema = z.object({
  query: z.object({
    status: z.enum(['COMPLETED', 'VOIDED']).optional(),
    from: optionalDateQuery,
    to: optionalDateQuery,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

export const posGymReportQuerySchema = z.object({
  query: z.object({
    from: optionalDateQuery,
    to: optionalDateQuery,
    groupBy: z.enum(['day', 'category', 'subcategory', 'product']).default('day'),
  }),
});

export const posCatalogQuerySchema = z.object({
  query: z.object({
    productType: productTypeSchema.optional(),
    includeDisabled: z.enum(['true', 'false']).optional(),
  }),
});

export const posStockHistoryQuerySchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});
