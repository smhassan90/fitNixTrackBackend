import { prisma } from '../lib/prisma';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { parseDate, formatDate } from '../utils/dateHelpers';
import { markOverduePayments } from './paymentService';

async function assertTrainerMemberAccess(gymId: number, trainerId: number, memberId: number) {
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
