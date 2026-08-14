import { z } from 'zod';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');
const ym = z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in YYYY-MM format');
const idParam = z.string().regex(/^\d+$/, 'ID must be a number').transform((val) => parseInt(val, 10));

const expenseKind = z.enum(['FIXED', 'PETTY', 'OTHER']);
const paymentMethod = z.enum(['CASH', 'ONLINE', 'OTHER']);

export const listExpenseCategoriesSchema = z.object({
  query: z.object({
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((val) => val === 'true'),
  }),
});

export const createExpenseCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(128),
    kind: expenseKind.optional().default('PETTY'),
    isRecurring: z.boolean().optional().default(false),
    defaultAmount: z.number().min(0).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

export const updateExpenseCategorySchema = z.object({
  params: z.object({ id: idParam }),
  body: z.object({
    name: z.string().min(1).max(128).optional(),
    kind: expenseKind.optional(),
    isRecurring: z.boolean().optional(),
    defaultAmount: z.number().min(0).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const getExpenseCategorySchema = z.object({
  params: z.object({ id: idParam }),
});

export const listExpenseEntriesSchema = z.object({
  query: z.object({
    from: ymd.optional(),
    to: ymd.optional(),
    categoryId: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
    kind: expenseKind.optional(),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  }),
});

export const createExpenseEntrySchema = z.object({
  body: z.object({
    categoryId: z.number().int().positive(),
    amount: z.number().positive('Amount must be greater than 0'),
    spentAt: ymd,
    paymentMethod: paymentMethod.nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  }),
});

export const updateExpenseEntrySchema = z.object({
  params: z.object({ id: idParam }),
  body: z.object({
    categoryId: z.number().int().positive().optional(),
    amount: z.number().positive().optional(),
    spentAt: ymd.optional(),
    paymentMethod: paymentMethod.nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  }),
});

export const getExpenseEntrySchema = z.object({
  params: z.object({ id: idParam }),
});

export const getPnlSummarySchema = z.object({
  query: z.object({
    month: ym.optional(),
  }),
});
