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

