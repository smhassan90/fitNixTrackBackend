import { z } from 'zod';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');
const idParam = z.string().regex(/^\d+$/, 'Employee ID must be a number').transform((val) => parseInt(val, 10));

export const createEmployeeSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    employeeNumber: z.string().max(64).optional().nullable(),
    phone: z.string().max(40).optional().nullable(),
    email: z.string().email('Invalid email format').max(191).optional().nullable(),
    gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
    dateOfBirth: ymd.optional().nullable(),
    designation: z.string().max(128).optional().nullable(),
    department: z.string().max(128).optional().nullable(),
    dateOfJoining: ymd.optional().nullable(),
    salary: z.number().min(0).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
});

export const updateEmployeeSchema = z.object({
  params: z.object({ id: idParam }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    employeeNumber: z.string().max(64).optional().nullable(),
    phone: z.string().max(40).optional().nullable(),
    email: z.string().email().max(191).optional().nullable(),
    gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
    dateOfBirth: ymd.optional().nullable(),
    designation: z.string().max(128).optional().nullable(),
    department: z.string().max(128).optional().nullable(),
    dateOfJoining: ymd.optional().nullable(),
    salary: z.number().min(0).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
});

export const getEmployeesSchema = z.object({
  query: z.object({
    search: z.string().optional(),
    designation: z.string().optional(),
    department: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 50)),
    createdFrom: ymd.optional(),
    createdTo: ymd.optional(),
    isActive: z
      .enum(['true', 'false'])
      .optional()
      .transform((val) => (val === undefined ? undefined : val === 'true')),
  }),
});

export const getEmployeeSchema = z.object({
  params: z.object({ id: idParam }),
});

export const deleteEmployeeSchema = z.object({
  params: z.object({ id: idParam }),
});

export const deactivateEmployeeSchema = z.object({
  params: z.object({ id: idParam }),
});

export const activateEmployeeSchema = z.object({
  params: z.object({ id: idParam }),
});
