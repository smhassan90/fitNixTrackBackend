import { prisma } from '../lib/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';
import { assertTrainerMemberAccess } from './mobileMemberService';

export type BodyMeasurementDto = {
  month: string;
  weightKg: number | null;
  armsCm: number | null;
  thighsCm: number | null;
  chestCm: number | null;
  waistCm: number | null;
};

function mapRow(row: {
  month: string;
  weightKg: number | null;
  armsCm: number | null;
  thighsCm: number | null;
  chestCm: number | null;
  waistCm: number | null;
}): BodyMeasurementDto {
  return {
    month: row.month,
    weightKg: row.weightKg,
    armsCm: row.armsCm,
    thighsCm: row.thighsCm,
    chestCm: row.chestCm,
    waistCm: row.waistCm,
  };
}

export async function getMemberHeightCm(memberId: number): Promise<number | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { heightCm: true },
  });
  return member?.heightCm ?? null;
}

export async function setMemberHeightCm(memberId: number, heightCm: number) {
  if (!Number.isFinite(heightCm) || heightCm < 50 || heightCm > 250) {
    throw new ValidationError('heightCm must be between 50 and 250');
  }
  const updated = await prisma.member.update({
    where: { id: memberId },
    data: { heightCm },
    select: { heightCm: true },
  });
  return { heightCm: updated.heightCm! };
}

export async function listMemberBodyMeasurements(memberId: number, limit = 24) {
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

  return {
    heightCm: member.heightCm,
    measurements: rows.map(mapRow),
  };
}

export async function upsertMemberBodyMeasurement(
  memberId: number,
  month: string,
  input: {
    weightKg?: number | null;
    armsCm?: number | null;
    thighsCm?: number | null;
    chestCm?: number | null;
    waistCm?: number | null;
  }
) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new ValidationError('month must be YYYY-MM');
  }

  const keys = ['weightKg', 'armsCm', 'thighsCm', 'chestCm', 'waistCm'] as const;
  const provided = keys.filter((k) => input[k] !== undefined);
  if (provided.length === 0) {
    throw new ValidationError('Provide at least one measurement field');
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
  for (const k of provided) {
    data[k] = input[k] as number | null;
  }

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

  return mapRow(row);
}

export async function getTrainerMemberBody(
  gymId: number,
  trainerId: number,
  memberId: number,
  limit = 24
) {
  await assertTrainerMemberAccess(gymId, trainerId, memberId);
  const body = await listMemberBodyMeasurements(memberId, limit);
  return {
    memberId,
    ...body,
  };
}
