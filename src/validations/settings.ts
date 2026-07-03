import { z } from 'zod';

export const getSettingsSchema = z.object({
  // No params or body needed for GET
});

export const updateSettingsSchema = z.object({
  body: z.object({
    admissionFee: z.number().min(0, 'Admission fee must be 0 or greater').optional(),
    autoCheckoutHours: z
      .number()
      .int()
      .min(1, 'Auto checkout must be at least 1 hour')
      .max(24, 'Auto checkout cannot exceed 24 hours')
      .optional(),
    absenceInactiveDays: z
      .number()
      .int()
      .min(1, 'Absence inactive days must be at least 1')
      .max(365, 'Absence inactive days cannot exceed 365')
      .nullable()
      .optional(),
  }),
});










