import { prisma } from '../lib/prisma';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors';
import { getStartOfDay } from '../utils/dateHelpers';
import { resolveMemberInternalId } from '../utils/memberLookup';

async function resolveActiveMemberId(gymId: number, rawMemberId: number | string): Promise<number> {
  const memberId = await resolveMemberInternalId(gymId, rawMemberId);
  if (!memberId) {
    throw new NotFoundError('Member', rawMemberId);
  }
  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    select: { id: true, isActive: true, name: true },
  });
  if (!member) {
    throw new NotFoundError('Member', rawMemberId);
  }
  if (!member.isActive) {
    throw new BadRequestError('Cannot record attendance for an inactive member');
  }
  return member.id;
}

export async function manualCheckIn(
  gymId: number,
  rawMemberId: number | string,
  checkInTimeInput?: Date
) {
  const memberId = await resolveActiveMemberId(gymId, rawMemberId);
  const checkInTime = checkInTimeInput ?? new Date();
  const dateOnly = getStartOfDay(checkInTime);

  const existing = await prisma.attendanceRecord.findUnique({
    where: {
      gymId_memberId_date: { gymId, memberId, date: dateOnly },
    },
  });

  if (existing?.checkInTime && !existing.checkOutTime) {
    throw new ConflictError('Member is already checked in');
  }

  if (existing?.checkInTime && existing.checkOutTime) {
    throw new ConflictError('Member has already completed attendance for this date');
  }

  if (existing) {
    return prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: {
        checkInTime,
        status: 'PRESENT',
      },
      include: {
        member: {
          select: { id: true, legacyMemberId: true, name: true, phone: true, email: true },
        },
      },
    });
  }

  return prisma.attendanceRecord.create({
    data: {
      gymId,
      memberId,
      date: dateOnly,
      status: 'PRESENT',
      checkInTime,
    },
    include: {
      member: {
        select: { id: true, legacyMemberId: true, name: true, phone: true, email: true },
      },
    },
  });
}

export async function manualCheckOut(
  gymId: number,
  rawMemberId: number | string,
  checkOutTimeInput?: Date
) {
  const memberId = await resolveActiveMemberId(gymId, rawMemberId);
  const checkOutTime = checkOutTimeInput ?? new Date();
  const dateOnly = getStartOfDay(checkOutTime);

  const existing = await prisma.attendanceRecord.findUnique({
    where: {
      gymId_memberId_date: { gymId, memberId, date: dateOnly },
    },
  });

  if (!existing?.checkInTime) {
    throw new BadRequestError('Member is not checked in for this date');
  }

  if (existing.checkOutTime) {
    throw new ConflictError('Member is already checked out for this date');
  }

  if (checkOutTime.getTime() < existing.checkInTime.getTime()) {
    throw new BadRequestError('Check-out time cannot be before check-in time');
  }

  return prisma.attendanceRecord.update({
    where: { id: existing.id },
    data: { checkOutTime },
    include: {
      member: {
        select: { id: true, legacyMemberId: true, name: true, phone: true, email: true },
      },
    },
  });
}
