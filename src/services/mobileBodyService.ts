import { prisma } from '../lib/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  DEFAULT_LENGTH_UNIT,
  circumferenceRange,
  convertNullableFromCm,
  fromCm,
  heightRange,
  normalizeLengthUnit,
  roundMeasure,
  toCm,
  type LengthUnit,
} from '../utils/lengthUnits';
import { assertTrainerMemberAccess } from './mobileMemberService';

export type BodyMeasurementDto = {
  month: string;
  weightKg: number | null;
  /** Circumference in the requested `unit`. */
  arms: number | null;
  thighs: number | null;
  chest: number | null;
  waist: number | null;
  /** Legacy aliases — same numeric values as above (in requested unit). */
  armsCm: number | null;
  thighsCm: number | null;
  chestCm: number | null;
  waistCm: number | null;
};

function mapRow(
  row: {
    month: string;
    weightKg: number | null;
    armsCm: number | null;
    thighsCm: number | null;
    chestCm: number | null;
    waistCm: number | null;
  },
  unit: LengthUnit
): BodyMeasurementDto {
  const arms = convertNullableFromCm(row.armsCm, unit);
  const thighs = convertNullableFromCm(row.thighsCm, unit);
  const chest = convertNullableFromCm(row.chestCm, unit);
  const waist = convertNullableFromCm(row.waistCm, unit);

  return {
    month: row.month,
    weightKg: row.weightKg,
    arms,
    thighs,
    chest,
    waist,
    // Keep legacy keys for older clients; values follow `unit`.
    armsCm: arms,
    thighsCm: thighs,
    chestCm: chest,
    waistCm: waist,
  };
}

export async function getMemberHeightCm(memberId: number): Promise<number | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { heightCm: true },
  });
  return member?.heightCm ?? null;
}

export async function setMemberHeight(
  memberId: number,
  input: { unit?: string; height?: number; heightCm?: number }
) {
  const unit = normalizeLengthUnit(input.unit ?? DEFAULT_LENGTH_UNIT);

  let heightCm: number;
  if (input.heightCm != null && Number.isFinite(input.heightCm)) {
    heightCm = input.heightCm;
  } else if (input.height != null && Number.isFinite(input.height)) {
    const range = heightRange(unit);
    if (input.height < range.min || input.height > range.max) {
      throw new ValidationError(`height must be between ${range.min} and ${range.max} ${unit}`);
    }
    heightCm = toCm(input.height, unit);
  } else {
    throw new ValidationError('Provide height (preferred) or heightCm');
  }

  const cmRange = heightRange('cm');
  if (heightCm < cmRange.min || heightCm > cmRange.max) {
    throw new ValidationError(`height must be between ${cmRange.min} and ${cmRange.max} cm`);
  }

  const updated = await prisma.member.update({
    where: { id: memberId },
    data: { heightCm },
    select: { heightCm: true },
  });

  const stored = updated.heightCm!;
  const height = roundMeasure(fromCm(stored, unit), unit);

  return {
    unit,
    height,
    heightCm: roundMeasure(stored, 'cm'),
  };
}

/** @deprecated Prefer setMemberHeight with unit. */
export async function setMemberHeightCm(memberId: number, heightCm: number) {
  return setMemberHeight(memberId, { unit: 'cm', heightCm });
}

export async function listMemberBodyMeasurements(
  memberId: number,
  limit = 24,
  unitRaw: string | LengthUnit = DEFAULT_LENGTH_UNIT
) {
  const unit = normalizeLengthUnit(unitRaw);
  const take = Math.min(Math.max(limit, 1), 60);
  const [member, rows] = await Promise.all([
    prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, heightCm: true },
    }),
    prisma.memberBodyMeasurement.findMany({
      where: { memberId },
      orderBy: { month: 'desc' },
      take,
    }),
  ]);

  if (!member) throw new NotFoundError('Member', memberId);

  const height = convertNullableFromCm(member.heightCm, unit);

  return {
    unit,
    height,
    /** Always centimeters for charts / legacy. */
    heightCm: member.heightCm == null ? null : roundMeasure(member.heightCm, 'cm'),
    measurements: rows.map((row) => mapRow(row, unit)),
  };
}

export async function upsertMemberBodyMeasurement(
  memberId: number,
  month: string,
  input: {
    unit?: string;
    weightKg?: number | null;
    arms?: number | null;
    thighs?: number | null;
    chest?: number | null;
    waist?: number | null;
    armsCm?: number | null;
    thighsCm?: number | null;
    chestCm?: number | null;
    waistCm?: number | null;
  }
) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new ValidationError('month must be YYYY-MM');
  }

  const unit = normalizeLengthUnit(input.unit ?? DEFAULT_LENGTH_UNIT);
  const range = circumferenceRange(unit);

  const resolveCircumference = (
    preferred: number | null | undefined,
    legacyCm: number | null | undefined,
    field: string
  ): number | null | undefined => {
    if (preferred !== undefined) {
      if (preferred == null) return null;
      if (preferred < range.min || preferred > range.max) {
        throw new ValidationError(
          `${field} must be between ${range.min} and ${range.max} ${unit}`
        );
      }
      return toCm(preferred, unit);
    }
    if (legacyCm !== undefined) {
      return legacyCm;
    }
    return undefined;
  };

  const armsCm = resolveCircumference(input.arms, input.armsCm, 'arms');
  const thighsCm = resolveCircumference(input.thighs, input.thighsCm, 'thighs');
  const chestCm = resolveCircumference(input.chest, input.chestCm, 'chest');
  const waistCm = resolveCircumference(input.waist, input.waistCm, 'waist');

  const hasAny =
    input.weightKg !== undefined ||
    armsCm !== undefined ||
    thighsCm !== undefined ||
    chestCm !== undefined ||
    waistCm !== undefined;

  if (!hasAny) {
    throw new ValidationError('Provide at least one measurement field');
  }

  if (input.weightKg != null && (input.weightKg < 20 || input.weightKg > 400)) {
    throw new ValidationError('weightKg must be between 20 and 400');
  }

  const existing = await prisma.memberBodyMeasurement.findUnique({
    where: { memberId_month: { memberId, month } },
  });

  const data: {
    weightKg?: number | null;
    armsCm?: number | null;
    thighsCm?: number | null;
    chestCm?: number | null;
    waistCm?: number | null;
  } = {};

  if (input.weightKg !== undefined) data.weightKg = input.weightKg;
  if (armsCm !== undefined) data.armsCm = armsCm;
  if (thighsCm !== undefined) data.thighsCm = thighsCm;
  if (chestCm !== undefined) data.chestCm = chestCm;
  if (waistCm !== undefined) data.waistCm = waistCm;

  const row = existing
    ? await prisma.memberBodyMeasurement.update({
        where: { id: existing.id },
        data,
      })
    : await prisma.memberBodyMeasurement.create({
        data: {
          memberId,
          month,
          weightKg: data.weightKg ?? null,
          armsCm: data.armsCm ?? null,
          thighsCm: data.thighsCm ?? null,
          chestCm: data.chestCm ?? null,
          waistCm: data.waistCm ?? null,
        },
      });

  return {
    unit,
    ...mapRow(row, unit),
  };
}

export async function getTrainerMemberBody(
  gymId: number,
  trainerId: number,
  memberId: number,
  limit = 24,
  unitRaw: string | LengthUnit = DEFAULT_LENGTH_UNIT
) {
  await assertTrainerMemberAccess(gymId, trainerId, memberId);
  const body = await listMemberBodyMeasurements(memberId, limit, unitRaw);
  return {
    memberId,
    ...body,
  };
}
