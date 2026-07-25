import { prisma } from '../lib/prisma';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { parseDate, formatDate, calendarDateStringInGymTZ } from '../utils/dateHelpers';
import { getGymTimezoneById } from './gymTimezoneService';
import { markOverduePayments } from './paymentService';

export async function assertTrainerMemberAccess(gymId: number, trainerId: number, memberId: number) {
  const link = await prisma.memberTrainer.findFirst({
    where: { trainerId, memberId, member: { gymId, isActive: true } },
  });
  if (!link) throw new ForbiddenError('Member is not assigned to you.');
}

export async function getMemberAttendance(
  gymId: number,
  memberId: number,
  query: { startDate?: string; endDate?: string; page?: number; limit?: number }
) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 30, 100);
  const where: { gymId: number; memberId: number; date?: { gte?: Date; lte?: Date } } = {
    gymId,
    memberId,
  };

  if (query.startDate || query.endDate) {
    where.date = {};
    if (query.startDate) where.date.gte = parseDate(query.startDate);
    if (query.endDate) where.date.lte = parseDate(query.endDate);
  }

  const [total, records] = await Promise.all([
    prisma.attendanceRecord.count({ where }),
    prisma.attendanceRecord.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const presentDays = await prisma.attendanceRecord.count({
    where: { ...where, status: 'PRESENT' },
  });

  return {
    records: records.map((r) => ({
      id: r.id,
      date: formatDate(r.date),
      status: r.status,
      checkInTime: r.checkInTime,
      checkOutTime: r.checkOutTime,
    })),
    summary: { totalRecords: total, presentDays },
    page,
    limit,
    total,
  };
}

export async function getMemberPayments(
  gymId: number,
  memberId: number,
  query: { status?: string; page?: number; limit?: number }
) {
  await markOverduePayments(gymId);

  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 20, 50);
  const where: {
    gymId: number;
    memberId: number;
    status?: 'PENDING' | 'PAID' | 'OVERDUE';
  } = { gymId, memberId };

  if (query.status) {
    where.status = query.status.toUpperCase() as 'PENDING' | 'PAID' | 'OVERDUE';
  }

  const [total, payments, overdueCount, nextDue] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: { dueDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.payment.count({ where: { gymId, memberId, status: 'OVERDUE' } }),
    prisma.payment.findFirst({
      where: { gymId, memberId, status: { in: ['PENDING', 'OVERDUE'] } },
      orderBy: { dueDate: 'asc' },
    }),
  ]);

  return {
    payments: payments.map((p) => ({
      id: p.id,
      month: p.month,
      amount: p.amount,
      status: p.status,
      dueDate: p.dueDate,
      paidDate: p.paidDate,
    })),
    summary: {
      overdueCount,
      nextDue: nextDue
        ? { month: nextDue.month, amount: nextDue.amount, dueDate: nextDue.dueDate, status: nextDue.status }
        : null,
    },
    page,
    limit,
    total,
  };
}

export async function listTrainerMembers(
  gymId: number,
  trainerId: number,
  query: { search?: string; page?: number; limit?: number }
) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 30, 50);
  const search = query.search?.trim().toLowerCase();

  const links = await prisma.memberTrainer.findMany({
    where: {
      trainerId,
      member: {
        gymId,
        isActive: true,
        ...(search
          ? {
              OR: [
                { name: { contains: search } },
                { phone: { contains: search } },
                { legacyMemberId: { contains: search } },
              ],
            }
          : {}),
      },
    },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          phone: true,
          photoUrl: true,
          legacyMemberId: true,
          package: { select: { name: true } },
        },
      },
    },
    orderBy: { member: { name: 'asc' } },
  });

  const all = links.map((l) => l.member);
  const total = all.length;
  const members = all.slice((page - 1) * limit, page * limit);

  return { members, total, page, limit };
}

export async function getTrainerMemberOverview(
  gymId: number,
  trainerId: number,
  memberId: number
) {
  await assertTrainerMemberAccess(gymId, trainerId, memberId);

  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    select: {
      id: true,
      name: true,
      phone: true,
      photoUrl: true,
      legacyMemberId: true,
      membershipStart: true,
      membershipEnd: true,
      package: { select: { name: true } },
    },
  });
  if (!member) throw new NotFoundError('Member', memberId);

  const [recentWorkouts, recentAttendance] = await Promise.all([
    prisma.workoutLog.findMany({
      where: { gymId, memberId },
      orderBy: { date: 'desc' },
      take: 7,
      select: { date: true, bodyParts: true },
    }),
    prisma.attendanceRecord.findMany({
      where: { gymId, memberId },
      orderBy: { date: 'desc' },
      take: 7,
      select: { date: true, status: true },
    }),
  ]);

  return {
    member,
    recentWorkouts: recentWorkouts.map((w) => ({
      date: formatDate(w.date),
      bodyParts: w.bodyParts,
    })),
    recentAttendance: recentAttendance.map((a) => ({
      date: formatDate(a.date),
      status: a.status,
    })),
  };
}

/**
 * Collective daily activity for all members assigned to a trainer.
 * Default date = today in the gym's IANA timezone (falls back to UTC / Asia/Karachi via gym record).
 */
export async function getTrainerMembersDailyActivity(
  gymId: number,
  trainerId: number,
  dateStr?: string
) {
  const timezone = await getGymTimezoneById(gymId);
  const date =
    dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
      ? dateStr
      : calendarDateStringInGymTZ(new Date(), timezone);
  const day = parseDate(date);

  const links = await prisma.memberTrainer.findMany({
    where: {
      trainerId,
      member: { gymId, isActive: true },
    },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          photoUrl: true,
          legacyMemberId: true,
        },
      },
    },
  });

  const memberIds = links.map((l) => l.member.id);
  if (memberIds.length === 0) {
    return {
      date,
      summary: {
        totalMembers: 0,
        workedOut: 0,
        present: 0,
        absentOrUnknown: 0,
      },
      members: [],
    };
  }

  const [attendanceRows, workoutRows] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { gymId, memberId: { in: memberIds }, date: day },
      select: {
        memberId: true,
        status: true,
        checkInTime: true,
        checkOutTime: true,
      },
    }),
    prisma.workoutLog.findMany({
      where: { gymId, memberId: { in: memberIds }, date: day },
      select: {
        id: true,
        memberId: true,
        bodyParts: true,
        notes: true,
      },
    }),
  ]);

  const attendanceByMember = new Map(attendanceRows.map((r) => [r.memberId, r]));
  const workoutByMember = new Map(
    workoutRows.filter((w) => w.memberId != null).map((w) => [w.memberId!, w])
  );

  const members = links.map((l) => {
    const m = l.member;
    const att = attendanceByMember.get(m.id);
    const workout = workoutByMember.get(m.id);
    return {
      id: m.id,
      name: m.name,
      photoUrl: m.photoUrl,
      legacyMemberId: m.legacyMemberId,
      attendance: att
        ? {
            status: att.status,
            checkInTime: att.checkInTime,
            checkOutTime: att.checkOutTime,
          }
        : null,
      workout: workout
        ? {
            id: workout.id,
            bodyParts: workout.bodyParts,
            notes: workout.notes,
          }
        : null,
    };
  });

  members.sort((a, b) => {
    const aActive =
      a.workout != null || a.attendance?.status === 'PRESENT' ? 0 : 1;
    const bActive =
      b.workout != null || b.attendance?.status === 'PRESENT' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  });

  const workedOut = members.filter((m) => m.workout != null).length;
  const present = members.filter((m) => m.attendance?.status === 'PRESENT').length;

  return {
    date,
    summary: {
      totalMembers: members.length,
      workedOut,
      present,
      absentOrUnknown: members.length - present,
    },
    members,
  };
}
