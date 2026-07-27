import { z } from 'zod';

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM');

const optionalMeasure = (min: number, max: number) =>
  z
    .number({ invalid_type_error: 'Must be a number' })
    .min(min)
    .max(max)
    .nullable()
    .optional();

export const mobileBodyHeightSchema = z.object({
  body: z.object({
    heightCm: z
      .number({ invalid_type_error: 'heightCm must be a number', required_error: 'heightCm is required' })
      .min(50, 'heightCm must be between 50 and 250')
      .max(250, 'heightCm must be between 50 and 250'),
  }),
});

export const mobileBodyMeasurementsListSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().positive().max(60).optional(),
  }),
});

export const mobileBodyMeasurementUpsertSchema = z.object({
  params: z.object({
    month: monthParam,
  }),
  body: z
    .object({
      weightKg: optionalMeasure(20, 400),
      armsCm: optionalMeasure(10, 300),
      thighsCm: optionalMeasure(10, 300),
      chestCm: optionalMeasure(10, 300),
      waistCm: optionalMeasure(10, 300),
    })
    .refine(
      (data) =>
        data.weightKg !== undefined ||
        data.armsCm !== undefined ||
        data.thighsCm !== undefined ||
        data.chestCm !== undefined ||
        data.waistCm !== undefined,
      { message: 'Provide at least one measurement field' }
    ),
});

export const mobileTrainerMemberBodySchema = z.object({
  params: z.object({
    memberId: z.coerce.number().int().positive(),
  }),
  query: z.object({
    limit: z.coerce.number().int().positive().max(60).optional(),
  }),
});
