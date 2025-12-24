import { z } from 'zod';

const cnicRegex = /^\d{13}$/;

export const createMemberSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    phone: z.string().optional().nullable(),
    email: z.string().email('Invalid email format').optional().nullable(),
    gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional().nullable(),
    cnic: z.string().regex(cnicRegex, 'CNIC must be exactly 13 digits').optional().nullable(),
    comments: z.string().max(1000).optional().nullable(),
    packageId: z
      .union([
        z.string().uuid('Invalid package ID format'),
        z.literal(''),
        z.null(),
      ])
      .optional()
      .transform((val) => (val === '' ? null : val)),
    discount: z.number().min(0).max(100).optional().nullable(),
    trainerIds: z.array(z.string().uuid()).optional().default([]),
  }),
});

export const updateMemberSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Member ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    phone: z.string().optional().nullable(),
    email: z.string().email().optional().nullable(),
    gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    cnic: z.string().regex(cnicRegex).optional().nullable(),
    comments: z.string().max(1000).optional().nullable(),
    packageId: z
      .union([
        z.string().uuid('Invalid package ID format'),
        z.literal(''),
        z.null(),
      ])
      .optional()
      .transform((val) => (val === '' ? null : val)),
    discount: z.number().min(0).max(100).optional().nullable(),
    trainerIds: z.array(z.string().uuid()).optional(),
  }),
});

export const getMembersSchema = z.object({
  query: z.object({
    search: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  }),
});

export const getMemberSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Member ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const deleteMemberSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Member ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

