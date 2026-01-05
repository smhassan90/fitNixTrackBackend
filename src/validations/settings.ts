import { z } from 'zod';

export const getSettingsSchema = z.object({
  // No params or body needed for GET
});

export const updateSettingsSchema = z.object({
  body: z.object({
    admissionFee: z.number().min(0, 'Admission fee must be 0 or greater').optional(),
  }),
});

