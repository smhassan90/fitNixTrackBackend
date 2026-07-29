import { z } from 'zod';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** ISO 8601 datetime with explicit timezone (Z or ±offset) from the client clock. */
const clientIsoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Must be a valid ISO datetime')
  .refine(
    (v) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(v.trim()),
    'Must include timezone (send client local time as ISO, e.g. new Date().toISOString())'
  );

const attendanceStatus = z.enum(['PRESENT', 'ABSENT', 'LATE']);

export const getEmployeeAttendanceSchema = z.object({
  query: z.object({
    employeeId: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
    startDate: ymd.optional(),
    endDate: ymd.optional(),
    status: attendanceStatus.optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  }),
});

export const getEmployeeAttendanceRecordSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Record ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const getDailyEmployeeAttendanceSchema = z.object({
  query: z.object({
    /** Gym-local calendar date. Defaults to today in gym timezone when omitted. */
    date: ymd.optional(),
    /** When true, include inactive employees. Default: active only. */
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((val) => val === 'true'),
  }),
});

export const employeeManualCheckInSchema = z.object({
  body: z.object({
    employeeId: z.coerce.number().int().positive(),
    checkInTime: clientIsoDateTime,
    status: attendanceStatus.optional(),
    notes: z.string().max(500).optional().nullable(),
  }),
});

export const employeeManualCheckOutSchema = z.object({
  body: z.object({
    employeeId: z.coerce.number().int().positive(),
    checkOutTime: clientIsoDateTime,
    notes: z.string().max(500).optional().nullable(),
  }),
});

export const markEmployeeAttendanceSchema = z.object({
  body: z.object({
    employeeId: z.coerce.number().int().positive(),
    date: ymd,
    status: attendanceStatus,
    checkInTime: clientIsoDateTime.optional().nullable(),
    checkOutTime: clientIsoDateTime.optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
  }),
});

export const bulkMarkEmployeeAttendanceSchema = z.object({
  body: z.object({
    date: ymd,
    records: z
      .array(
        z.object({
          employeeId: z.coerce.number().int().positive(),
          status: attendanceStatus,
          checkInTime: clientIsoDateTime.optional().nullable(),
          checkOutTime: clientIsoDateTime.optional().nullable(),
          notes: z.string().max(500).optional().nullable(),
        })
      )
      .min(1, 'At least one attendance record is required')
      .max(200),
  }),
});
