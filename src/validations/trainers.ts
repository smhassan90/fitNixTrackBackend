import { z } from 'zod';

const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/; // HH:mm format

export const createTrainerSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional().nullable(),
    specialization: z.string().max(500).optional().nullable(),
    charges: z.number().min(0).optional().nullable(),
    startTime: z.string().regex(timeRegex, 'Time must be in HH:mm format').optional().nullable(),
    endTime: z.string().regex(timeRegex, 'Time must be in HH:mm format').optional().nullable(),
  }),
});

export const updateTrainerSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Trainer ID must be a number').transform((val) => parseInt(val, 10)),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    specialization: z.string().max(500).optional().nullable(),
    charges: z.number().min(0).optional().nullable(),
    startTime: z.string().regex(timeRegex).optional().nullable(),
    endTime: z.string().regex(timeRegex).optional().nullable(),
  }),
});

export const getTrainersSchema = z.object({
  query: z.object({
    search: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
    page: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z.string().regex(/^\d+$/).optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  }),
});

export const getTrainerSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Trainer ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

export const deleteTrainerSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Trainer ID must be a number').transform((val) => parseInt(val, 10)),
  }),
});

