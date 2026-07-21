import { prisma } from '../lib/prisma';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors';
import {
  calendarDateStringInGymTZ,
  getGymTimezone,
  parseDate,
} from '../utils/dateHelpers';
import { resolveMemberInternalId } from '../utils/memberLookup';
import { getOverduePaymentDetailsByMemberIds } from './attendancePolicyService';

function formatCheckInTime(checkInTime: Date): string {
  return checkInTime.toLocaleString('en-US', {
    timeZone: getGymTimezone(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function attendanceDateForInstant(instant: Date): Date {
  return parseDate(calendarDateStringInGymTZ(instant));
}

export type ManualCheckInPortalResponse = {
  message: string;
  checkInTime: string;
  checkInFormatted: string;
  attendanceRecordId: string;
  overdueAlerts: Array<{
    attendanceRecordId: number;
    memberId: number;
    memberNumber: string | null;
    legacyMemberId: string | null;
    memberName: string;
    contact: string;
    checkInTime: string;
    overdueCount: number;
    overdueAmount: number;
    overdueSince: string;
    overdueMonths: string[];
  }>;
};

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
  checkInTime: Date
): Promise<ManualCheckInPortalResponse> {
  const memberId = await resolveActiveMemberId(gymId, rawMemberId);
  const dateOnly = attendanceDateForInstant(checkInTime);

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

  const record = existing
    ? await prisma.attendanceRecord.update({
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
      })
    : await prisma.attendanceRecord.create({
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

  const checkIn = record.checkInTime!;
  const overdueByMember = await getOverduePaymentDetailsByMemberIds(gymId, [record.memberId]);
  const overdueInfo = overdueByMember.get(record.memberId);
  const memberNumber = record.member.legacyMemberId?.trim() || null;

  const overdueAlerts = overdueInfo
    ? [{
        attendanceRecordId: record.id,
        memberId: record.member.id,
        memberNumber,
        legacyMemberId: memberNumber,
        memberName: record.member.name,
        contact: record.member.phone || record.member.email || 'N/A',
        checkInTime: checkIn.toISOString(),
        overdueCount: overdueInfo.overdueCount,
        overdueAmount: overdueInfo.overdueAmount,
        overdueSince: overdueInfo.overdueSince,
        overdueMonths: overdueInfo.overdueMonths,
      }]
    : [];

  return {
    message: 'Member checked in successfully.',
    checkInTime: checkIn.toISOString(),
    checkInFormatted: formatCheckInTime(checkIn),
    attendanceRecordId: String(record.id),
    overdueAlerts,
  };
}

export async function manualCheckOut(
  gymId: number,
  rawMemberId: number | string,
  checkOutTime: Date
) {
  const memberId = await resolveActiveMemberId(gymId, rawMemberId);
  const dateOnly = attendanceDateForInstant(checkOutTime);

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
