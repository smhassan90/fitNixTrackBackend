import { z } from 'zod';

const monthRegex = /^\d{4}-\d{2}$/; // YYYY-MM format

export const createPaymentSchema = z.object({
  body: z.object({
    memberId: z.string().uuid('Invalid member ID'),
    month: z.string().regex(monthRegex, 'Month must be in YYYY-MM format'),
    amount: z.number().min(0, 'Amount must be non-negative'),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  }),
});

export const updatePaymentSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  body: z.object({
    month: z.string().regex(monthRegex).optional(),
    amount: z.number().min(0).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(['PENDING', 'PAID', 'OVERDUE']).optional(),
  }),
});

export const getPaymentsSchema = z.object({
  query: z.object({
    memberId: z.string().uuid().optional(),
    status: z.enum(['PENDING', 'PAID', 'OVERDUE']).optional(),
    month: z.string().regex(monthRegex).optional(),
    search: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  }),
});

export const getPaymentSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

export const markPaidSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

export const deletePaymentSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

