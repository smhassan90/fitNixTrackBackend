/** Length units for body measurements. Storage is always centimeters. */
export type LengthUnit = 'cm' | 'in';

export const DEFAULT_LENGTH_UNIT: LengthUnit = 'in';

const CM_PER_INCH = 2.54;

export function normalizeLengthUnit(raw: unknown): LengthUnit {
  if (typeof raw !== 'string') return DEFAULT_LENGTH_UNIT;
  const v = raw.trim().toLowerCase();
  if (v === 'cm' || v === 'centimeter' || v === 'centimeters') return 'cm';
  if (v === 'in' || v === 'inch' || v === 'inches') return 'in';
  return DEFAULT_LENGTH_UNIT;
}

/** Convert a value in `unit` into centimeters for storage. */
export function toCm(value: number, unit: LengthUnit): number {
  if (unit === 'cm') return value;
  return value * CM_PER_INCH;
}

/** Convert a stored centimeter value into `unit` for API responses. */
export function fromCm(value: number, unit: LengthUnit): number {
  if (unit === 'cm') return value;
  return value / CM_PER_INCH;
}

export function roundMeasure(value: number, unit: LengthUnit): number {
  // inches: 1 decimal; cm: 1 decimal
  const factor = 10;
  return Math.round(value * factor) / factor;
}

export function convertNullableFromCm(
  value: number | null | undefined,
  unit: LengthUnit
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return roundMeasure(fromCm(value, unit), unit);
}

export function heightRange(unit: LengthUnit): { min: number; max: number } {
  return unit === 'cm' ? { min: 50, max: 250 } : { min: 20, max: 98 };
}

export function circumferenceRange(unit: LengthUnit): { min: number; max: number } {
  return unit === 'cm' ? { min: 10, max: 300 } : { min: 4, max: 118 };
}
