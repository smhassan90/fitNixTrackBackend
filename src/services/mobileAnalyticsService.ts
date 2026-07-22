import { MobileAccountType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { WORKOUT_BODY_PARTS, WorkoutBodyPart } from '../constants/bodyParts';
import { parseDate, formatDate } from '../utils/dateHelpers';
import { ForbiddenError } from '../utils/errors';

type AnalyticsSubject = {
  gymId: number;
  accountType: MobileAccountType;
  memberId?: number;
  trainerId?: number;
};

async function assertTrainerMemberAccess(gymId: number, trainerId: number, memberId: number) {
  const link = await prisma.memberTrainer.findFirst({
    where: { trainerId, memberId, member: { gymId } },
  });
  if (!link) throw new ForbiddenError('Cannot view analytics for this member.');
}

function defaultRange(days: number) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start, end };
}

export async function getWorkoutAnalytics(
  subject: AnalyticsSubject,
  query: { startDate?: string; endDate?: string; memberId?: number }
) {
  let memberId = subject.memberId;
  let trainerId = subject.trainerId;

  if (subject.accountType === 'TRAINER' && query.memberId) {
    await assertTrainerMemberAccess(subject.gymId, subject.trainerId!, query.memberId);
    memberId = query.memberId;
    trainerId = undefined;
  }

  const range =
    query.startDate && query.endDate
      ? { start: parseDate(query.startDate), end: parseDate(query.endDate) }
      : defaultRange(30);

  const where: Prisma.WorkoutLogWhereInput = {
    gymId: subject.gymId,
    date: { gte: range.start, lte: range.end },
  };

  if (memberId) {
    where.accountType = 'MEMBER';
    where.memberId = memberId;
  } else {
    where.accountType = 'TRAINER';
    where.trainerId = trainerId;
  }

  const logs = await prisma.workoutLog.findMany({
    where,
    orderBy: { date: 'asc' },
    select: { date: true, bodyParts: true },
  });

  const bodyPartCounts: Record<WorkoutBodyPart, number> = Object.fromEntries(
    WORKOUT_BODY_PARTS.map((p) => [p, 0])
  ) as Record<WorkoutBodyPart, number>;

  const activeDays: string[] = [];
  for (const log of logs) {
    activeDays.push(formatDate(log.date));
    const parts = log.bodyParts as string[];
    for (const part of parts) {
      if (part in bodyPartCounts) {
        bodyPartCounts[part as WorkoutBodyPart] += 1;
      }
    }
  }

  const totalWorkoutDays = logs.length;
  const calendarDays =
    Math.floor((range.end.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000)) + 1;

  const bodyPartBreakdown = WORKOUT_BODY_PARTS.map((part) => ({
    part,
    count: bodyPartCounts[part],
    percentage:
      totalWorkoutDays > 0
        ? Math.round((bodyPartCounts[part] / totalWorkoutDays) * 100)
        : 0,
  })).filter((row) => row.count > 0);

  const weeklyActivity: { week: string; days: number }[] = [];
  const weekMap = new Map<string, number>();
  for (const day of activeDays) {
    const d = parseDate(day);
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const key = formatDate(weekStart);
    weekMap.set(key, (weekMap.get(key) ?? 0) + 1);
  }
  for (const [week, days] of [...weekMap.entries()].sort()) {
    weeklyActivity.push({ week, days });
  }

  return {
    range: { startDate: formatDate(range.start), endDate: formatDate(range.end) },
    summary: {
      totalWorkoutDays,
      calendarDays,
      consistencyPercent:
        calendarDays > 0 ? Math.round((totalWorkoutDays / calendarDays) * 100) : 0,
    },
    bodyPartBreakdown,
    weeklyActivity,
    activeDays,
  };
}

export async function getNutritionAnalytics(
  subject: AnalyticsSubject,
  query: { startDate?: string; endDate?: string; memberId?: number }
) {
  let memberId = subject.memberId;

  if (subject.accountType === 'TRAINER' && query.memberId) {
    await assertTrainerMemberAccess(subject.gymId, subject.trainerId!, query.memberId);
    memberId = query.memberId;
  } else if (subject.accountType === 'TRAINER' && !query.memberId) {
    memberId = undefined;
  }

  const range =
    query.startDate && query.endDate
      ? { start: parseDate(query.startDate), end: parseDate(query.endDate) }
      : defaultRange(30);

  const orderWhere: Prisma.MobileOrderWhereInput = {
    gymId: subject.gymId,
    status: 'COMPLETED',
    completedAt: { gte: range.start, lte: new Date(range.end.getTime() + 86400000 - 1) },
  };

  if (memberId) {
    orderWhere.memberId = memberId;
  } else if (subject.accountType === 'TRAINER') {
    orderWhere.trainerId = subject.trainerId;
  }

  const completedOrders = await prisma.mobileOrder.findMany({
    where: orderWhere,
    include: { items: true },
    orderBy: { completedAt: 'asc' },
  });

  let totalCalories = 0;
  let totalProteinG = 0;
  let totalCarbsG = 0;
  let totalFatG = 0;
  const dailyMap = new Map<string, { calories: number; proteinG: number }>();

  for (const order of completedOrders) {
    const day = order.completedAt ? formatDate(order.completedAt) : formatDate(order.createdAt);
    const dayEntry = dailyMap.get(day) ?? { calories: 0, proteinG: 0 };
    for (const item of order.items) {
      const qty = item.quantity;
      totalCalories += (item.calories ?? 0) * qty;
      totalProteinG += (item.proteinG ?? 0) * qty;
      totalCarbsG += (item.carbsG ?? 0) * qty;
      totalFatG += (item.fatG ?? 0) * qty;
      dayEntry.calories += (item.calories ?? 0) * qty;
      dayEntry.proteinG += (item.proteinG ?? 0) * qty;
    }
    dailyMap.set(day, dayEntry);
  }

  const dailyNutrition = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values }));

  return {
    range: { startDate: formatDate(range.start), endDate: formatDate(range.end) },
    summary: {
      ordersDelivered: completedOrders.length,
      totalCalories: Math.round(totalCalories),
      totalProteinG: Math.round(totalProteinG * 10) / 10,
      totalCarbsG: Math.round(totalCarbsG * 10) / 10,
      totalFatG: Math.round(totalFatG * 10) / 10,
    },
    dailyNutrition,
  };
}

export async function getCombinedAnalytics(
  subject: AnalyticsSubject,
  query: { startDate?: string; endDate?: string; memberId?: number }
) {
  const [workout, nutrition] = await Promise.all([
    getWorkoutAnalytics(subject, query),
    getNutritionAnalytics(subject, query),
  ]);
  return { workout, nutrition };
}
