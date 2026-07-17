import { prisma } from '../lib/prisma';
import {
  calendarDateStringInGymTZ,
  getGymTimezone,
  getStartOfDay,
  getEndOfDay,
  parseDate,
  unpaidInstallmentDisplayBucket,
} from '../utils/dateHelpers';

export const DEFAULT_AUTO_CHECKOUT_HOURS = 6;

export interface GymAttendancePolicy {
  autoCheckoutHours: number;
  absenceInactiveDays: number | null;
  absenceInactiveEnabled: boolean;
}

export interface CurrentlyInGymMember {
  memberId: number;
  memberName: string;
  contact: string;
  checkInTime: string;
  checkInFormatted: string | null;
  durationMinutes: number;
  durationFormatted: string;
  attendanceRecordId: number;
  hasOverduePayment: boolean;
}

export interface NoSignInMember {
  memberId: number;
  memberName: string;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  lastCheckInTime: string | null;
  lastCheckInDate: string | null;
  daysSinceLastSignIn: number | null;
  hasOverduePayment: boolean;
}

export async function getGymAttendancePolicy(gymId: number): Promise<GymAttendancePolicy> {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { autoCheckoutHours: true, absenceInactiveDays: true },
  });

  const autoCheckoutHours = gym?.autoCheckoutHours ?? DEFAULT_AUTO_CHECKOUT_HOURS;
  const absenceInactiveDays = gym?.absenceInactiveDays ?? null;

  return {
    autoCheckoutHours,
    absenceInactiveDays,
    absenceInactiveEnabled: absenceInactiveDays != null && absenceInactiveDays > 0,
  };
}

/** Close open sessions when check-in was more than autoCheckoutHours ago. */
export async function applyAutoCheckoutForOpenSessions(
  gymId: number,
  autoCheckoutHours: number = DEFAULT_AUTO_CHECKOUT_HOURS
): Promise<number> {
  const now = new Date();
  const msPerHour = 60 * 60 * 1000;

  const openRecords = await prisma.attendanceRecord.findMany({
    where: {
      gymId,
      checkInTime: { not: null },
      checkOutTime: null,
    },
    select: { id: true, checkInTime: true },
  });

  let closed = 0;
  for (const record of openRecords) {
    const checkIn = record.checkInTime!;
    const autoCheckoutAt = new Date(checkIn.getTime() + autoCheckoutHours * msPerHour);
    if (now >= autoCheckoutAt) {
      await prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { checkOutTime: autoCheckoutAt },
      });
      closed++;
    }
  }

  return closed;
}

/**
 * Mark active members inactive when their last check-in is older than absenceInactiveDays.
 * Uses the same inactiveFrom + payment cleanup pattern as manual deactivation.
 */
export async function markMembersInactiveAfterAbsence(
  gymId: number,
  absenceInactiveDays: number
): Promise<number> {
  if (absenceInactiveDays <= 0) {
    return 0;
  }

  const tz = getGymTimezone();
  const todayStr = calendarDateStringInGymTZ(new Date(), tz);
  const cutoffStr = shiftCalendarDateString(todayStr, -absenceInactiveDays);
  const cutoffStart = getStartOfDay(parseDate(cutoffStr));
  const effectiveDate = getStartOfDay(parseDate(todayStr));

  const activeMembers = await prisma.member.findMany({
    where: { gymId, isActive: true },
    select: { id: true },
  });

  if (activeMembers.length === 0) {
    return 0;
  }

  const memberIds = activeMembers.map((m) => m.id);

  const lastCheckIns = await prisma.attendanceRecord.groupBy({
    by: ['memberId'],
    where: {
      gymId,
      memberId: { in: memberIds },
      checkInTime: { not: null },
    },
    _max: { checkInTime: true },
  });

  const lastCheckInByMember = new Map<number, Date>();
  for (const row of lastCheckIns) {
    if (row._max.checkInTime) {
      lastCheckInByMember.set(row.memberId, row._max.checkInTime);
    }
  }

  let markedInactive = 0;

  for (const member of activeMembers) {
    const lastCheckIn = lastCheckInByMember.get(member.id);
    const shouldDeactivate =
      !lastCheckIn || lastCheckIn.getTime() < cutoffStart.getTime();

    if (!shouldDeactivate) {
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.member.update({
        where: { id: member.id },
        data: {
          isActive: false,
          inactiveFrom: effectiveDate,
        },
      });

      await tx.payment.deleteMany({
        where: {
          gymId,
          memberId: member.id,
          status: { in: ['PENDING', 'OVERDUE'] },
          dueDate: { gte: effectiveDate },
        },
      });
    });

    markedInactive++;
  }

  return markedInactive;
}

/** Run auto-checkout and optional absence-based deactivation after attendance sync. */
export async function applyAttendancePolicies(gymId: number): Promise<{
  autoCheckedOut: number;
  markedInactive: number;
}> {
  const policy = await getGymAttendancePolicy(gymId);

  const autoCheckedOut = await applyAutoCheckoutForOpenSessions(
    gymId,
    policy.autoCheckoutHours
  );

  let markedInactive = 0;
  if (policy.absenceInactiveEnabled && policy.absenceInactiveDays != null) {
    markedInactive = await markMembersInactiveAfterAbsence(
      gymId,
      policy.absenceInactiveDays
    );
  }

  return { autoCheckedOut, markedInactive };
}

export interface MemberOverduePaymentInfo {
  memberId: number;
  /** Number of overdue (past-due unpaid) installments. */
  overdueCount: number;
  /** Total amount across overdue installments. */
  overdueAmount: number;
  /** Due date of the oldest overdue installment (ISO). */
  overdueSince: string;
  /** Billing months (YYYY-MM) that are overdue, oldest first. */
  overdueMonths: string[];
}

/**
 * Detailed overdue-installment info per member (past-due unpaid installments only).
 * A payment counts as overdue when status is OVERDUE or its due date is before today in gym TZ.
 */
export async function getOverduePaymentDetailsByMemberIds(
  gymId: number,
  memberIds: number[]
): Promise<Map<number, MemberOverduePaymentInfo>> {
  if (memberIds.length === 0) {
    return new Map();
  }

  const tz = getGymTimezone();
  const payments = await prisma.payment.findMany({
    where: {
      gymId,
      memberId: { in: [...new Set(memberIds)] },
      status: { in: ['PENDING', 'OVERDUE'] },
    },
    select: { memberId: true, status: true, dueDate: true, amount: true, month: true },
    orderBy: { dueDate: 'asc' },
  });

  const details = new Map<number, MemberOverduePaymentInfo>();
  for (const p of payments) {
    const isOverdue =
      p.status === 'OVERDUE' || unpaidInstallmentDisplayBucket(p.dueDate, tz) === 'overdue';
    if (!isOverdue) {
      continue;
    }

    const existing = details.get(p.memberId);
    if (!existing) {
      details.set(p.memberId, {
        memberId: p.memberId,
        overdueCount: 1,
        overdueAmount: p.amount,
        overdueSince: p.dueDate.toISOString(),
        overdueMonths: [p.month],
      });
    } else {
      existing.overdueCount += 1;
      existing.overdueAmount += p.amount;
      existing.overdueMonths.push(p.month);
    }
  }

  return details;
}

export async function getOverduePaymentMemberIds(
  gymId: number,
  memberIds: number[]
): Promise<Set<number>> {
  const details = await getOverduePaymentDetailsByMemberIds(gymId, memberIds);
  return new Set(details.keys());
}

export async function getCurrentlyInGymMembers(gymId: number): Promise<{
  count: number;
  members: CurrentlyInGymMember[];
  policy: GymAttendancePolicy;
}> {
  const policy = await getGymAttendancePolicy(gymId);
  await applyAutoCheckoutForOpenSessions(gymId, policy.autoCheckoutHours);

  const today = new Date();
  const todayStart = getStartOfDay(today);
  const todayEnd = getEndOfDay(today);
  const now = new Date();
  const msPerHour = 60 * 60 * 1000;
  const maxSessionMs = policy.autoCheckoutHours * msPerHour;

  const records = await prisma.attendanceRecord.findMany({
    where: {
      gymId,
      date: { gte: todayStart, lte: todayEnd },
      checkInTime: { not: null },
      checkOutTime: null,
    },
    include: {
      member: {
        select: { id: true, name: true, phone: true, email: true },
      },
    },
    orderBy: { checkInTime: 'asc' },
  });

  const stillInside = records.filter((record) => {
    const checkIn = record.checkInTime!;
    return now.getTime() - checkIn.getTime() < maxSessionMs;
  });

  const memberIds = stillInside.map((r) => r.member.id);
  const overdueIds = await getOverduePaymentMemberIds(gymId, memberIds);

  const members: CurrentlyInGymMember[] = stillInside.map((record) => {
    const checkInTime = record.checkInTime!;
    const diffMs = now.getTime() - checkInTime.getTime();
    const durationMinutes = Math.max(0, Math.round(diffMs / (1000 * 60)));
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    const durationFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    return {
      memberId: record.member.id,
      memberName: record.member.name,
      contact: record.member.phone || record.member.email || 'N/A',
      checkInTime: checkInTime.toISOString(),
      checkInFormatted: checkInTime.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }),
      durationMinutes,
      durationFormatted,
      attendanceRecordId: record.id,
      hasOverduePayment: overdueIds.has(record.member.id),
    };
  });

  return {
    count: members.length,
    members,
    policy,
  };
}

export async function listMembersWithoutSignInSince(
  gymId: number,
  days: number
): Promise<{
  days: number;
  cutoffDate: string;
  total: number;
  members: NoSignInMember[];
}> {
  if (days < 1) {
    throw new Error('days must be at least 1');
  }

  const tz = getGymTimezone();
  const todayStr = calendarDateStringInGymTZ(new Date(), tz);
  const cutoffStr = shiftCalendarDateString(todayStr, -days);
  const cutoffStart = getStartOfDay(parseDate(cutoffStr));

  const allMembers = await prisma.member.findMany({
    where: { gymId, isActive: true },
    select: { id: true, name: true, phone: true, email: true, isActive: true },
    orderBy: { name: 'asc' },
  });

  if (allMembers.length === 0) {
    return { days, cutoffDate: cutoffStr, total: 0, members: [] };
  }

  const memberIds = allMembers.map((m) => m.id);

  const lastCheckIns = await prisma.attendanceRecord.groupBy({
    by: ['memberId'],
    where: {
      gymId,
      memberId: { in: memberIds },
      checkInTime: { not: null },
    },
    _max: { checkInTime: true },
  });

  const lastCheckInByMember = new Map<number, Date>();
  for (const row of lastCheckIns) {
    if (row._max.checkInTime) {
      lastCheckInByMember.set(row.memberId, row._max.checkInTime);
    }
  }

  const noSignInMembers = allMembers.filter((member) => {
    const last = lastCheckInByMember.get(member.id);
    return !last || last.getTime() < cutoffStart.getTime();
  });

  const overdueIds = await getOverduePaymentMemberIds(
    gymId,
    noSignInMembers.map((m) => m.id)
  );

  const members: NoSignInMember[] = noSignInMembers.map((member) => {
    const lastCheckIn = lastCheckInByMember.get(member.id) ?? null;
    let daysSinceLastSignIn: number | null = null;

    if (lastCheckIn) {
      const lastDateStr = calendarDateStringInGymTZ(lastCheckIn, tz);
      daysSinceLastSignIn = daysBetweenCalendarDates(lastDateStr, todayStr);
    }

    return {
      memberId: member.id,
      memberName: member.name,
      phone: member.phone,
      email: member.email,
      isActive: member.isActive,
      lastCheckInTime: lastCheckIn ? lastCheckIn.toISOString() : null,
      lastCheckInDate: lastCheckIn
        ? calendarDateStringInGymTZ(lastCheckIn, tz)
        : null,
      daysSinceLastSignIn,
      hasOverduePayment: overdueIds.has(member.id),
    };
  });

  members.sort((a, b) => {
    const daysA = a.daysSinceLastSignIn ?? Number.MAX_SAFE_INTEGER;
    const daysB = b.daysSinceLastSignIn ?? Number.MAX_SAFE_INTEGER;
    return daysB - daysA;
  });

  return {
    days,
    cutoffDate: cutoffStr,
    total: members.length,
    members,
  };
}

function shiftCalendarDateString(dateStr: string, dayDelta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dayDelta);
  return dt.toISOString().slice(0, 10);
}

function daysBetweenCalendarDates(fromStr: string, toStr: string): number {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000));
}
