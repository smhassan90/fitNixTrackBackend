import { z } from 'zod';
import {
  DEFAULT_LENGTH_UNIT,
  circumferenceRange,
  heightRange,
  normalizeLengthUnit,
  type LengthUnit,
} from '../utils/lengthUnits';

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM');

const unitSchema = z
  .preprocess((val) => {
    if (val === undefined || val === null || val === '') return DEFAULT_LENGTH_UNIT;
    return normalizeLengthUnit(val);
  }, z.enum(['cm', 'in']))
  .default(DEFAULT_LENGTH_UNIT);

/** Accept JSON numbers or numeric strings from mobile clients. */
const optionalMeasure = () =>
  z.preprocess((val) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    if (typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val))) {
      return Number(val);
    }
    return val;
  }, z.number().nullable().optional());

const requiredNumber = z.preprocess((val) => {
  if (typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val))) {
    return Number(val);
  }
  return val;
}, z.number({ required_error: 'height is required' }));

export const mobileBodyHeightSchema = z.object({
  body: z
    .object({
      unit: unitSchema,
      /** Preferred: height in the selected `unit` (default inches). */
      height: requiredNumber.optional(),
      /** Legacy: always centimeters. */
      heightCm: requiredNumber.optional(),
    })
    .superRefine((data, ctx) => {
      const unit = (data.unit ?? DEFAULT_LENGTH_UNIT) as LengthUnit;
      const range = heightRange(unit);

      if (data.height == null && data.heightCm == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Provide height (preferred) or heightCm',
          path: ['height'],
        });
        return;
      }

      if (data.height != null) {
        if (data.height < range.min || data.height > range.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `height must be between ${range.min} and ${range.max} ${unit}`,
            path: ['height'],
          });
        }
      }

      if (data.heightCm != null) {
        const cmRange = heightRange('cm');
        if (data.heightCm < cmRange.min || data.heightCm > cmRange.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `heightCm must be between ${cmRange.min} and ${cmRange.max}`,
            path: ['heightCm'],
          });
        }
      }
    }),
});

export const mobileBodyMeasurementsListSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().positive().max(60).optional(),
    unit: unitSchema.optional(),
  }),
});

export const mobileBodyMeasurementUpsertSchema = z.object({
  params: z.object({
    month: monthParam,
  }),
  body: z
    .object({
      unit: unitSchema,
      weightKg: optionalMeasure(),
      /** Preferred unit-agnostic circumference fields (interpreted via `unit`). */
      arms: optionalMeasure(),
      thighs: optionalMeasure(),
      chest: optionalMeasure(),
      waist: optionalMeasure(),
      /** Legacy cm fields (always centimeters). */
      armsCm: optionalMeasure(),
      thighsCm: optionalMeasure(),
      chestCm: optionalMeasure(),
      waistCm: optionalMeasure(),
    })
    .superRefine((data, ctx) => {
      const unit = (data.unit ?? DEFAULT_LENGTH_UNIT) as LengthUnit;
      const range = circumferenceRange(unit);
      const cmRange = circumferenceRange('cm');

      const hasAny =
        data.weightKg !== undefined ||
        data.arms !== undefined ||
        data.thighs !== undefined ||
        data.chest !== undefined ||
        data.waist !== undefined ||
        data.armsCm !== undefined ||
        data.thighsCm !== undefined ||
        data.chestCm !== undefined ||
        data.waistCm !== undefined;

      if (!hasAny) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Provide at least one measurement field',
        });
      }

      if (data.weightKg != null && (data.weightKg < 20 || data.weightKg > 400)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'weightKg must be between 20 and 400',
          path: ['weightKg'],
        });
      }

      for (const key of ['arms', 'thighs', 'chest', 'waist'] as const) {
        const v = data[key];
        if (v != null && (v < range.min || v > range.max)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${key} must be between ${range.min} and ${range.max} ${unit}`,
            path: [key],
          });
        }
      }

      for (const key of ['armsCm', 'thighsCm', 'chestCm', 'waistCm'] as const) {
        const v = data[key];
        if (v != null && (v < cmRange.min || v > cmRange.max)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${key} must be between ${cmRange.min} and ${cmRange.max}`,
            path: [key],
          });
        }
      }
    }),
});

export const mobileTrainerMemberBodySchema = z.object({
  params: z.object({
    memberId: z.coerce.number().int().positive(),
  }),
  query: z.object({
    limit: z.coerce.number().int().positive().max(60).optional(),
    unit: unitSchema.optional(),
  }),
});
