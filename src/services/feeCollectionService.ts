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

  try {
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
  } catch (error: unknown) {
    // Concurrent backfills / retries can race past the findUnique above.
    const code = (error as { code?: string } | null)?.code;
    if (code === 'P2002') {
      return;
    }
    throw error;
  }
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

/**
 * Remove fee_collections whose source payment is missing or no longer PAID.
 * Heals dashboard income / recent payments after incomplete undo/delete.
 */
const purgeCache = new Map<number, number>();
const PURGE_CACHE_TTL_MS = 15_000;

/** Drop cached purge result so the next dashboard read re-checks the ledger. */
export function invalidatePurgeCache(gymId: number): void {
  purgeCache.delete(gymId);
}

/**
 * Remove every ledger row tied to a signup / one-time payment, including orphan
 * SIGNUP_FEE / ADMISSION_ONLY rows keyed only by member + collected date.
 */
export async function removeSignupFeeCollectionsForOneTimePayment(
  db: Tx | typeof prisma,
  params: {
    gymId: number;
    memberId: number;
    oneTimePaymentId: number;
    paidDate?: Date | null;
  }
): Promise<void> {
  const { gymId, memberId, oneTimePaymentId, paidDate } = params;

  await removeFeeCollectionBySource(db, 'ONE_TIME_PAYMENT', oneTimePaymentId, gymId);

  const orphanWhere: Prisma.FeeCollectionWhereInput = {
    gymId,
    memberId,
    category: { in: ['SIGNUP_FEE', 'ADMISSION_ONLY'] },
  };
  if (paidDate) {
    orphanWhere.collectedAt = { gte: normalizeCollectedAt(paidDate) };
  }

  await db.feeCollection.deleteMany({ where: orphanWhere });
}

export async function purgeStaleFeeCollections(gymId: number): Promise<number> {
  const now = Date.now();
  const last = purgeCache.get(gymId);
  if (last != null && now - last < PURGE_CACHE_TTL_MS) {
    return 0;
  }
  purgeCache.set(gymId, now);

  const rows = await prisma.feeCollection.findMany({
    where: { gymId },
    select: { id: true, sourceType: true, sourceId: true },
  });
  if (rows.length === 0) return 0;

  const monthlyIds = [
    ...new Set(
      rows.filter((r) => r.sourceType === 'MONTHLY_PAYMENT').map((r) => r.sourceId)
    ),
  ];
  const oneTimeIds = [
    ...new Set(
      rows.filter((r) => r.sourceType === 'ONE_TIME_PAYMENT').map((r) => r.sourceId)
    ),
  ];

  const [paidMonthly, paidOneTime] = await Promise.all([
    monthlyIds.length
      ? prisma.payment.findMany({
          where: { gymId, id: { in: monthlyIds }, status: 'PAID' },
          select: { id: true },
        })
      : Promise.resolve([] as { id: number }[]),
    oneTimeIds.length
      ? prisma.oneTimePayment.findMany({
          where: { gymId, id: { in: oneTimeIds }, status: 'PAID' },
          select: { id: true },
        })
      : Promise.resolve([] as { id: number }[]),
  ]);

  const validMonthly = new Set(paidMonthly.map((p) => p.id));
  const validOneTime = new Set(paidOneTime.map((p) => p.id));

  const staleIds = rows
    .filter((r) =>
      r.sourceType === 'MONTHLY_PAYMENT'
        ? !validMonthly.has(r.sourceId)
        : !validOneTime.has(r.sourceId)
    )
    .map((r) => r.id);

  if (staleIds.length === 0) return 0;

  await prisma.feeCollection.deleteMany({
    where: { gymId, id: { in: staleIds } },
  });
  return staleIds.length;
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
  await purgeStaleFeeCollections(gymId);

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
  await purgeStaleFeeCollections(gymId);

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
  await purgeStaleFeeCollections(gymId);

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
  await purgeStaleFeeCollections(gymId);

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
