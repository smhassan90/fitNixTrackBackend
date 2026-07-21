import { z } from 'zod';

export const getAttendanceSchema = z.object({
  query: z.object({
    memberId: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  }),
});

export const getAttendanceRecordSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

export const getNoSignInMembersSchema = z.object({
  query: z.object({
    days: z
      .string()
      .regex(/^\d+$/, 'days must be a positive integer')
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 2)),
  }),
});

export const applyAttendancePoliciesSchema = z.object({});

export const getOverdueCheckinsSchema = z.object({
  query: z.object({
    /** Only include check-ins at/after this time (ISO 8601). Default: start of today. */
    since: z
      .string()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), 'since must be a valid ISO datetime')
      .optional(),
  }),
});

export const manualCheckInSchema = z.object({
  body: z.object({
    memberId: z.coerce.number().int().positive(),
    checkInTime: z
      .string()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), 'checkInTime must be a valid ISO datetime')
      .optional(),
  }),
});

export const manualCheckOutSchema = z.object({
  body: z.object({
    memberId: z.union([z.number().int().positive(), z.string().min(1)]),
    checkOutTime: z
      .string()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), 'checkOutTime must be a valid ISO datetime')
      .optional(),
  }),
});
