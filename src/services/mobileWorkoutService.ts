import { MobileAccountType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { normalizeBodyParts, WorkoutBodyPart } from '../constants/bodyParts';
import { parseDate, formatDate } from '../utils/dateHelpers';

type MobileActor = {
  gymId: number;
  accountType: MobileAccountType;
  memberId?: number;
  trainerId?: number;
};

function serializeWorkout(log: {
  id: number;
  accountType: MobileAccountType;
  memberId: number | null;
  trainerId: number | null;
  date: Date;
  bodyParts: unknown;
  notes: string | null;
  loggedByType: MobileAccountType;
  loggedByTrainerId: number | null;
  createdAt: Date;
  updatedAt: Date;
  member?: { id: number; name: string; legacyMemberId: string | null } | null;
  trainer?: { id: number; name: string } | null;
}) {
  return {
    id: log.id,
    accountType: log.accountType,
    memberId: log.memberId,
    trainerId: log.trainerId,
    memberName: log.member?.name ?? null,
    memberNumber: log.member?.legacyMemberId ?? null,
    trainerName: log.trainer?.name ?? null,
    date: formatDate(log.date),
    bodyParts: log.bodyParts as WorkoutBodyPart[],
    notes: log.notes,
    loggedByType: log.loggedByType,
    loggedByTrainerId: log.loggedByTrainerId,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
  };
}

const workoutInclude = {
  member: { select: { id: true, name: true, legacyMemberId: true } },
  trainer: { select: { id: true, name: true } },
};

async function assertTrainerCanAccessMember(
  gymId: number,
  trainerId: number,
  memberId: number
) {
  const link = await prisma.memberTrainer.findFirst({
    where: { trainerId, memberId, member: { gymId, isActive: true } },
  });
  if (!link) {
    throw new ForbiddenError('You can only manage workouts for your assigned members.');
  }
}

export async function upsertWorkout(
  actor: MobileActor,
  input: {
    date: string;
    bodyParts: string[];
    notes?: string | null;
    /** Trainer logging for a member */
    memberId?: number;
    /** Trainer logging for themselves */
    forSelf?: boolean;
  }
) {
  const bodyParts = normalizeBodyParts(input.bodyParts);
  if (bodyParts.length === 0) {
    throw new BadRequestError('Select at least one body part');
  }

  const date = parseDate(input.date);

  if (actor.accountType === 'MEMBER') {
    const memberId = actor.memberId!;
    const data = {
      gymId: actor.gymId,
      accountType: 'MEMBER' as MobileAccountType,
      memberId,
      trainerId: null,
      loggedByType: 'MEMBER' as MobileAccountType,
      loggedByMemberId: memberId,
      loggedByTrainerId: null,
      date,
      bodyParts,
      notes: input.notes?.trim() || null,
    };

    const log = await prisma.workoutLog.upsert({
      where: {
        gymId_memberId_date: { gymId: actor.gymId, memberId, date },
      },
      create: data,
      update: { bodyParts, notes: data.notes, loggedByType: 'MEMBER', loggedByTrainerId: null },
      include: workoutInclude,
    });
    return serializeWorkout(log);
  }

  const trainerId = actor.trainerId!;

  if (input.memberId) {
    await assertTrainerCanAccessMember(actor.gymId, trainerId, input.memberId);
    const data = {
      gymId: actor.gymId,
      accountType: 'MEMBER' as MobileAccountType,
      memberId: input.memberId,
      trainerId: null,
      loggedByType: 'TRAINER' as MobileAccountType,
      loggedByMemberId: null,
      loggedByTrainerId: trainerId,
      date,
      bodyParts,
      notes: input.notes?.trim() || null,
    };
    const log = await prisma.workoutLog.upsert({
      where: {
        gymId_memberId_date: { gymId: actor.gymId, memberId: input.memberId, date },
      },
      create: data,
      update: {
        bodyParts,
        notes: data.notes,
        loggedByType: 'TRAINER',
        loggedByTrainerId: trainerId,
      },
      include: workoutInclude,
    });
    return serializeWorkout(log);
  }

  const data = {
    gymId: actor.gymId,
    accountType: 'TRAINER' as MobileAccountType,
    memberId: null,
    trainerId,
    loggedByType: 'TRAINER' as MobileAccountType,
    loggedByMemberId: null,
    loggedByTrainerId: trainerId,
    date,
    bodyParts,
    notes: input.notes?.trim() || null,
  };

  const log = await prisma.workoutLog.upsert({
    where: {
      gymId_trainerId_date: { gymId: actor.gymId, trainerId, date },
    },
    create: data,
    update: { bodyParts, notes: data.notes },
    include: workoutInclude,
  });
  return serializeWorkout(log);
}

export async function listWorkouts(
  actor: MobileActor,
  query: {
    startDate?: string;
    endDate?: string;
    memberId?: number;
    page?: number;
    limit?: number;
  }
) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 30, 100);
  const where: Prisma.WorkoutLogWhereInput = { gymId: actor.gymId };

  if (query.startDate || query.endDate) {
    where.date = {};
    if (query.startDate) where.date.gte = parseDate(query.startDate);
    if (query.endDate) where.date.lte = parseDate(query.endDate);
  }

  if (actor.accountType === 'MEMBER') {
    where.accountType = 'MEMBER';
    where.memberId = actor.memberId;
  } else if (query.memberId) {
    await assertTrainerCanAccessMember(actor.gymId, actor.trainerId!, query.memberId);
    where.accountType = 'MEMBER';
    where.memberId = query.memberId;
  } else {
    where.accountType = 'TRAINER';
    where.trainerId = actor.trainerId;
  }

  const [total, logs] = await Promise.all([
    prisma.workoutLog.count({ where }),
    prisma.workoutLog.findMany({
      where,
      include: workoutInclude,
      orderBy: { date: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    workouts: logs.map(serializeWorkout),
    total,
    page,
    limit,
  };
}

export async function getWorkoutByDate(
  actor: MobileActor,
  dateStr: string,
  memberId?: number
) {
  const date = parseDate(dateStr);
  let where: Prisma.WorkoutLogWhereInput;

  if (actor.accountType === 'MEMBER') {
    where = { gymId: actor.gymId, memberId: actor.memberId, date };
  } else if (memberId) {
    await assertTrainerCanAccessMember(actor.gymId, actor.trainerId!, memberId);
    where = { gymId: actor.gymId, memberId, date };
  } else {
    where = { gymId: actor.gymId, trainerId: actor.trainerId, date };
  }

  const log = await prisma.workoutLog.findFirst({
    where,
    include: workoutInclude,
  });
  if (!log) throw new NotFoundError('Workout');
  return serializeWorkout(log);
}

export async function deleteWorkout(actor: MobileActor, workoutId: number) {
  const log = await prisma.workoutLog.findFirst({
    where: { id: workoutId, gymId: actor.gymId },
  });
  if (!log) throw new NotFoundError('Workout', workoutId);

  if (actor.accountType === 'MEMBER') {
    if (log.memberId !== actor.memberId) {
      throw new ForbiddenError('Cannot delete this workout');
    }
  } else if (log.memberId) {
    await assertTrainerCanAccessMember(actor.gymId, actor.trainerId!, log.memberId);
  } else if (log.trainerId !== actor.trainerId) {
    throw new ForbiddenError('Cannot delete this workout');
  }

  await prisma.workoutLog.delete({ where: { id: workoutId } });
}
