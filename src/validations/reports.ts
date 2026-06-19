import { z } from 'zod';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');
const ym = z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in YYYY-MM format');
const feeCategory = z.enum(['MONTHLY_FEE', 'SIGNUP_FEE', 'ADMISSION_ONLY']);

export const getAttendanceReportSchema = z.object({
  query: z.object({
    startDate: ymd.optional(),
    endDate: ymd.optional(),
  }),
});

export const getFinancialSummarySchema = z.object({
  query: z.object({
    startDate: ymd,
    endDate: ymd,
    reportMonth: ym,
  }),
});

export const getPaymentsReceivedDailySchema = z.object({
  query: z.object({
    startDate: ymd,
    endDate: ymd,
  }),
});

export const getFeeCollectionsSchema = z.object({
  query: z.object({
    startDate: ymd.optional(),
    endDate: ymd.optional(),
    billingMonth: ym.optional(),
    category: feeCategory.optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  }),
});

export const getRevenueReportSchema = z.object({
  query: z.object({
    startMonth: ym,
    endMonth: ym,
  }),
});

