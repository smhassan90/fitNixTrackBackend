import { FeeCollectionCategory, FeeCollectionSourceType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  formatMonth,
  getGymTimezone,
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
} from '../utils/dateHelpers';
import { normalizeOneTimePaymentBreakdown } from './paymentService';

type Tx = Prisma.TransactionClient;

export type FeeCollectionRow = {
  id: number;
  /** Internal PK — use for API links only, never display. */
  memberId: number;
  /** Gym-facing member number (legacyMemberId). */
  memberNumber: string | null;
  memberName: string;
  amount: number;
  collectedAt: Date;
  billingMonth: string | null;
  category: FeeCollectionCategory;
  description: string;
  sourceType: FeeCollectionSourceType;
  sourceId: number;
};

function normalizeCollectedAt(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function buildSignupDescription(
  memberName: string,
  billingMonth: string | null,
  admissionFee: number,
  totalAmount: number
): { category: FeeCollectionCategory; description: string } {
  if (totalAmount <= admissionFee + 0.01) {
    return {
      category: 'ADMISSION_ONLY',
      description: `Admission fee — ${memberName}`,
    };
  }
  const monthLabel = billingMonth ? ` (${billingMonth})` : '';
  return {
    category: 'SIGNUP_FEE',
    description: `Signup payment (admission + first month${monthLabel}) — ${memberName}`,
  };
}

async function isMonthlyCollectionCoveredBySignup(
  db: Tx | typeof prisma,
  params: {
    gymId: number;
    memberId: number;
    billingMonth: string;
  }
): Promise<boolean> {
  const member = await db.member.findFirst({
    where: { id: params.memberId, gymId: params.gymId },
    select: { membershipStart: true, oneTimePaymentPaid: true },
  });
  if (!member?.oneTimePaymentPaid || !member.membershipStart) {
    return false;
  }
  if (formatMonth(member.membershipStart) !== params.billingMonth) {
    return false;
  }
  const signup = await db.oneTimePayment.findFirst({
    where: { memberId: params.memberId, gymId: params.gymId, status: 'PAID' },
    orderBy: { createdAt: 'asc' },
    select: { totalAmount: true, admissionFee: true },
  });
  if (!signup) {
    return false;
  }
  return signup.totalAmount > signup.admissionFee + 0.01;
}

export async function recordMonthlyFeeCollection(
  db: Tx | typeof prisma,
  params: {
    gymId: number;
    memberId: number;
    memberName: string;
    paymentId: number;
    amount: number;
    billingMonth: string;
    collectedAt: Date;
  }
): Promise<void> {
  if (await isMonthlyCollectionCoveredBySignup(db, params)) {
    return;
  }

  const existing = await db.feeCollection.findUnique({
    where: {
      sourceType_sourceId: {
        sourceType: 'MONTHLY_PAYMENT',
        sourceId: params.paymentId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return;
  }

  await db.feeCollection.create({
    data: {
      gymId: params.gymId,
      memberId: params.memberId,
      amount: params.amount,
      collectedAt: normalizeCollectedAt(params.collectedAt),
      billingMonth: params.billingMonth,
      category: 'MONTHLY_FEE',
      description: `Monthly membership fee (${params.billingMonth}) — ${params.memberName}`,
      sourceType: 'MONTHLY_PAYMENT',
      sourceId: params.paymentId,
    },
  });
}

export async function recordOneTimeFeeCollection(
  db: Tx | typeof prisma,
  params: {
    gymId: number;
    memberId: number;
    memberName: string;
    oneTimePaymentId: number;
    admissionFee: number;
    packageFee: number;
    trainerFee: number;
    totalAmount: number;
    collectedAt: Date;
    billingMonth: string | null;
  }
): Promise<void> {
  const existing = await db.feeCollection.findUnique({
    where: {
      sourceType_sourceId: {
        sourceType: 'ONE_TIME_PAYMENT',
        sourceId: params.oneTimePaymentId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return;
  }

  const normalized = normalizeOneTimePaymentBreakdown({
    admissionFee: params.admissionFee,
    packageFee: params.packageFee,
    trainerFee: params.trainerFee,
    totalAmount: params.totalAmount,
  });
  const { category, description } = buildSignupDescription(
    params.memberName,
    params.billingMonth,
    normalized.admissionFee,
    normalized.totalAmount
  );

  await db.feeCollection.create({
    data: {
      gymId: params.gymId,
      memberId: params.memberId,
      amount: normalized.totalAmount,
      collectedAt: normalizeCollectedAt(params.collectedAt),
      billingMonth: params.billingMonth,
      category,
      description,
      sourceType: 'ONE_TIME_PAYMENT',
      sourceId: params.oneTimePaymentId,
    },
  });
}

export async function removeFeeCollectionBySource(
  db: Tx | typeof prisma,
  sourceType: FeeCollectionSourceType,
  sourceId: number,
  gymId: number
): Promise<void> {
  await db.feeCollection.deleteMany({
    where: { sourceType, sourceId, gymId },
  });
}

export type CollectedSummaryInRange = {
  totalAmount: number;
  transactionCount: number;
  memberCount: number;
  byCategory: Record<FeeCollectionCategory, number>;
};

/** Cash collected in date range (by collectedAt), scoped to one gym. */
export async function getCollectedSummaryInDateRange(
  gymId: number,
  rangeStart: Date,
  rangeEndExclusive: Date
): Promise<CollectedSummaryInRange> {
  const rows = await prisma.feeCollection.findMany({
    where: {
      gymId,
      collectedAt: { gte: rangeStart, lt: rangeEndExclusive },
    },
    select: { amount: true, memberId: true, category: true },
  });

  const byCategory: Record<FeeCollectionCategory, number> = {
    MONTHLY_FEE: 0,
    SIGNUP_FEE: 0,
    ADMISSION_ONLY: 0,
  };
  const memberIds = new Set<number>();
  let totalAmount = 0;

  for (const row of rows) {
    totalAmount += row.amount;
    memberIds.add(row.memberId);
    byCategory[row.category] += row.amount;
  }

  return {
    totalAmount,
    transactionCount: rows.length,
    memberCount: memberIds.size,
    byCategory,
  };
}

export async function getCollectedByCategoryForBillingMonth(
  gymId: number,
  billingMonth: string
): Promise<Record<FeeCollectionCategory, number>> {
  const rows = await prisma.feeCollection.findMany({
    where: { gymId, billingMonth },
    select: { amount: true, category: true },
  });
  const byCategory: Record<FeeCollectionCategory, number> = {
    MONTHLY_FEE: 0,
    SIGNUP_FEE: 0,
    ADMISSION_ONLY: 0,
  };
  for (const row of rows) {
    byCategory[row.category] += row.amount;
  }
  return byCategory;
}

export async function getCollectedAmountForBillingMonth(
  gymId: number,
  billingMonth: string
): Promise<{ amount: number; memberCount: number }> {
  const rows = await prisma.feeCollection.findMany({
    where: { gymId, billingMonth },
    select: { amount: true, memberId: true },
  });
  const memberIds = new Set<number>();
  let amount = 0;
  for (const row of rows) {
    amount += row.amount;
    memberIds.add(row.memberId);
  }
  return { amount, memberCount: memberIds.size };
}

export async function getCollectedAmountInDateRange(
  gymId: number,
  rangeStart: Date,
  rangeEndExclusive: Date
): Promise<number> {
  const agg = await prisma.feeCollection.aggregate({
    where: {
      gymId,
      collectedAt: { gte: rangeStart, lt: rangeEndExclusive },
    },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0;
}

export async function getRevenueByBillingMonth(
  gymId: number,
  startMonth: string,
  endMonth: string
): Promise<Record<string, number>> {
  const rows = await prisma.feeCollection.findMany({
    where: {
      gymId,
      billingMonth: { gte: startMonth, lte: endMonth },
    },
    select: { billingMonth: true, amount: true },
  });
  const revenueByMonth: Record<string, number> = {};
  for (const row of rows) {
    if (!row.billingMonth) {
      continue;
    }
    revenueByMonth[row.billingMonth] = (revenueByMonth[row.billingMonth] || 0) + row.amount;
  }
  return revenueByMonth;
}

export async function getRecentFeeCollections(
  gymId: number,
  limit = 10
): Promise<FeeCollectionRow[]> {
  const rows = await prisma.feeCollection.findMany({
    where: { gymId },
    include: {
      member: { select: { name: true, legacyMemberId: true } },
    },
    orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });

  return rows.map(mapFeeCollectionRow);
}

function mapFeeCollectionRow(row: {
  id: number;
  memberId: number;
  member: { name: string; legacyMemberId: string | null };
  amount: number;
  collectedAt: Date;
  billingMonth: string | null;
  category: FeeCollectionCategory;
  description: string;
  sourceType: FeeCollectionSourceType;
  sourceId: number;
}): FeeCollectionRow {
  return {
    id: row.id,
    memberId: row.memberId,
    memberNumber: row.member.legacyMemberId?.trim() || null,
    memberName: row.member.name,
    amount: row.amount,
    collectedAt: row.collectedAt,
    billingMonth: row.billingMonth,
    category: row.category,
    description: row.description,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
  };
}

export async function listFeeCollections(
  gymId: number,
  options: {
    startDate?: string;
    endDate?: string;
    billingMonth?: string;
    category?: FeeCollectionCategory;
    page: number;
    limit: number;
  }
): Promise<{ rows: FeeCollectionRow[]; total: number }> {
  const where: Prisma.FeeCollectionWhereInput = { gymId };

  if (options.billingMonth) {
    where.billingMonth = options.billingMonth;
  }
  if (options.category) {
    where.category = options.category;
  }

  if (options.startDate || options.endDate) {
    const tz = getGymTimezone();
    where.collectedAt = {};
    if (options.startDate) {
      where.collectedAt.gte = startOfGymCalendarDayUtc(options.startDate, tz);
    }
    if (options.endDate) {
      where.collectedAt.lt = startOfNextGymCalendarDayUtc(options.endDate, tz);
    }
  }

  const [total, rows] = await Promise.all([
    prisma.feeCollection.count({ where }),
    prisma.feeCollection.findMany({
      where,
      include: { member: { select: { name: true, legacyMemberId: true } } },
      orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    }),
  ]);

  return {
    rows: rows.map(mapFeeCollectionRow),
    total,
  };
}
