import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { normalizeBodyParts, WORKOUT_BODY_PARTS, WorkoutBodyPart } from '../constants/bodyParts';
import { parseDate, formatDate } from '../utils/dateHelpers';

function serializeGuestWorkout(log: {
  id: number;
  date: Date;
  bodyParts: unknown;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: log.id,
    accountType: 'GUEST' as const,
    memberId: null,
    trainerId: null,
    memberName: null,
    memberNumber: null,
    trainerName: null,
    date: formatDate(log.date),
    bodyParts: log.bodyParts as WorkoutBodyPart[],
    notes: log.notes,
    loggedByType: 'GUEST' as const,
    loggedByTrainerId: null,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
  };
}

export async function upsertGuestWorkout(
  googleUserId: number,
  input: { date: string; bodyParts: string[]; notes?: string | null }
) {
  const bodyParts = normalizeBodyParts(input.bodyParts);
  if (bodyParts.length === 0) {
    throw new BadRequestError('Select at least one body part');
  }
  const date = parseDate(input.date);

  const log = await prisma.guestWorkoutLog.upsert({
    where: {
      googleUserId_date: { googleUserId, date },
    },
    create: {
      googleUserId,
      date,
      bodyParts,
      notes: input.notes?.trim() || null,
    },
    update: {
      bodyParts,
      notes: input.notes?.trim() || null,
    },
  });

  return serializeGuestWorkout(log);
}

export async function listGuestWorkouts(
  googleUserId: number,
  query: { startDate?: string; endDate?: string; page?: number; limit?: number }
) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 30, 100);
  const where: Prisma.GuestWorkoutLogWhereInput = { googleUserId };

  if (query.startDate || query.endDate) {
    where.date = {};
    if (query.startDate) where.date.gte = parseDate(query.startDate);
    if (query.endDate) where.date.lte = parseDate(query.endDate);
  }

  const [total, logs] = await Promise.all([
    prisma.guestWorkoutLog.count({ where }),
    prisma.guestWorkoutLog.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    workouts: logs.map(serializeGuestWorkout),
    total,
    page,
    limit,
  };
}

export async function getGuestWorkoutByDate(googleUserId: number, dateStr: string) {
  const date = parseDate(dateStr);
  const log = await prisma.guestWorkoutLog.findFirst({
    where: { googleUserId, date },
  });
  if (!log) throw new NotFoundError('Workout');
  return serializeGuestWorkout(log);
}

export async function deleteGuestWorkout(googleUserId: number, workoutId: number) {
  const log = await prisma.guestWorkoutLog.findFirst({
    where: { id: workoutId, googleUserId },
  });
  if (!log) throw new NotFoundError('Workout', workoutId);
  await prisma.guestWorkoutLog.delete({ where: { id: workoutId } });
}

function defaultRange(days: number) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start, end };
}

export async function getGuestWorkoutAnalytics(
  googleUserId: number,
  query: { startDate?: string; endDate?: string }
) {
  const range =
    query.startDate && query.endDate
      ? { start: parseDate(query.startDate), end: parseDate(query.endDate) }
      : defaultRange(30);

  const logs = await prisma.guestWorkoutLog.findMany({
    where: {
      googleUserId,
      date: { gte: range.start, lte: range.end },
    },
    orderBy: { date: 'asc' },
    select: { date: true, bodyParts: true },
  });

  const bodyPartCounts: Record<WorkoutBodyPart, number> = Object.fromEntries(
    WORKOUT_BODY_PARTS.map((p) => [p, 0])
  ) as Record<WorkoutBodyPart, number>;

  const activeDays: string[] = [];
  for (const log of logs) {
    activeDays.push(formatDate(log.date));
    for (const part of log.bodyParts as string[]) {
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
      totalWorkoutDays > 0 ? Math.round((bodyPartCounts[part] / totalWorkoutDays) * 100) : 0,
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
    workout: {
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
    },
    nutrition: {
      range: { startDate: formatDate(range.start), endDate: formatDate(range.end) },
      summary: {
        ordersDelivered: 0,
        totalCalories: 0,
        totalProteinG: 0,
        totalCarbsG: 0,
        totalFatG: 0,
      },
      dailyNutrition: [],
    },
  };
}

export function assertNotGuestFeature(isGuest: boolean, feature: string): void {
  if (isGuest) {
    throw new ForbiddenError(
      `${feature} is available only for gym members linked by Gmail on their profile.`
    );
  }
}
