import { prisma } from '../lib/prisma';
import { ValidationError } from '../utils/errors';
import {
  getGymTimezone,
  calendarDateStringInGymTZ,
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
  enumerateGymCalendarDaysInclusive,
  unpaidInstallmentDisplayBucket,
} from '../utils/dateHelpers';
import { getCollectedAmountForBillingMonth } from './feeCollectionService';

const DEFAULT_CURRENCY = process.env.REPORT_CURRENCY?.trim() || 'PKR';

const MAX_REPORT_RANGE_DAYS = 400;

function assertDateRangeOrder(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new ValidationError('startDate must be on or before endDate');
  }
  const start = startOfGymCalendarDayUtc(startDate);
  const endExclusive = startOfNextGymCalendarDayUtc(endDate);
  const days = (endExclusive.getTime() - start.getTime()) / 86400000;
  if (days > MAX_REPORT_RANGE_DAYS) {
    throw new ValidationError(`Date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days`);
  }
}

export type FinancialSummaryResult = {
  newMembersInRange: number;
  newTrainersInRange: number;
  /**
   * Expected monthly fee for `reportMonth`: **one installment per member** (latest `Payment.id` wins if duplicates exist).
   * Sum of `amount` for those canonical rows. Excludes one-time/admission.
   */
  expectedRevenueThisMonth: number;
  /** Distinct members included in `expectedRevenueThisMonth` (same dedupe rule). */
  expectedMemberCount: number;
  /**
   * Raw row count of `Payment` with `month === reportMonth` before per-member dedupe.
   * If greater than `expectedMemberCount`, the DB has duplicate month rows for some members (inflates naive sums).
   */
  expectedInstallmentRowCount: number;
  /**
   * Sum of fee collection ledger rows for `reportMonth` (billing month attribution).
   */
  collectedAmountThisMonth: number;
  /** Distinct members with ≥1 fee collection row for `reportMonth`. */
  collectedMemberCount: number;
  /**
   * Bucket totals use the **next unpaid installment per member** only (earliest `dueDate`, tie-break lower `id`),
   * same basis as `GET /api/dashboard/stats` pending/overdue counts — not every open row in the gym.
   * Each *Amount and *Count use the **same** rows: that next row per member with **amount > 0**, classified by
   * `unpaidInstallmentDisplayBucket` (gym TZ). *Count is the number of members in that bucket.
   */
  overdueAmount: number;
  pendingAmount: number;
  advanceAmount: number;
  /** Members whose next unpaid installment is in the overdue display bucket (same as overdueMemberCount). */
  overdueCount: number;
  /** Members whose next unpaid installment is in the pending display bucket (same as pendingMemberCount). */
  pendingCount: number;
  /** Members whose next unpaid installment is in the advance display bucket (same as advanceMemberCount). */
  advanceCount: number;
  /** Explicit aliases for portal/docs; equal to overdueCount / pendingCount / advanceCount respectively. */
  overdueMemberCount: number;
  pendingMemberCount: number;
  advanceMemberCount: number;
  currency: string;
};

/**
 * expectedRevenueThisMonth: per member, at most one installment row for `reportMonth` (highest `id` if duplicates).
 * Does not include OneTimePayment or admission-only rows.
 */
export async function getFinancialSummary(
  gymId: number,
  startDate: string,
  endDate: string,
  reportMonth: string
): Promise<FinancialSummaryResult> {
  assertDateRangeOrder(startDate, endDate);
  if (!/^\d{4}-\d{2}$/.test(reportMonth)) {
    throw new ValidationError('reportMonth must be YYYY-MM');
  }

  const tz = getGymTimezone();
  const rangeStart = startOfGymCalendarDayUtc(startDate, tz);
  const rangeEndExclusive = startOfNextGymCalendarDayUtc(endDate, tz);

  const [newMembersInRange, newTrainersInRange, monthInstallments, openInstallments] = await Promise.all([
    prisma.member.count({
      where: {
        gymId,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive },
      },
    }),
    prisma.trainer.count({
      where: {
        gymId,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive },
      },
    }),
    prisma.payment.findMany({
      where: { gymId, month: reportMonth },
      select: { id: true, memberId: true, amount: true, status: true },
      orderBy: { id: 'asc' },
    }),
    prisma.payment.findMany({
      where: {
        gymId,
        status: { in: ['PENDING', 'OVERDUE'] },
      },
      select: { id: true, memberId: true, amount: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
    }),
  ]);

  const expectedInstallmentRowCount = monthInstallments.length;

  const collected = await getCollectedAmountForBillingMonth(gymId, reportMonth);
  const collectedAmountThisMonth = collected.amount;
  const collectedMemberCount = collected.memberCount;

  const canonicalByMember = new Map<number, { amount: number; id: number }>();
  for (const p of monthInstallments) {
    const cur = canonicalByMember.get(p.memberId);
    if (!cur || p.id > cur.id) {
      canonicalByMember.set(p.memberId, { amount: p.amount, id: p.id });
    }
  }

  let expectedRevenueThisMonth = 0;
  for (const row of canonicalByMember.values()) {
    expectedRevenueThisMonth += row.amount;
  }
  const expectedMemberCount = canonicalByMember.size;

  let overdueAmount = 0;
  let pendingAmount = 0;
  let advanceAmount = 0;
  let overdueCount = 0;
  let pendingCount = 0;
  let advanceCount = 0;

  const nextOpenByMember = new Map<
    number,
    { amount: number; dueDate: Date; id: number }
  >();
  for (const p of openInstallments) {
    const existing = nextOpenByMember.get(p.memberId);
    const earlier =
      !existing ||
      p.dueDate.getTime() < existing.dueDate.getTime() ||
      (p.dueDate.getTime() === existing.dueDate.getTime() && p.id < existing.id);
    if (earlier) {
      nextOpenByMember.set(p.memberId, {
        amount: p.amount,
        dueDate: p.dueDate,
        id: p.id,
      });
    }
  }

  for (const p of nextOpenByMember.values()) {
    if (p.amount <= 0) {
      continue;
    }
    const bucket = unpaidInstallmentDisplayBucket(p.dueDate, tz);
    if (bucket === 'overdue') {
      overdueAmount += p.amount;
      overdueCount++;
    } else if (bucket === 'pending') {
      pendingAmount += p.amount;
      pendingCount++;
    } else {
      advanceAmount += p.amount;
      advanceCount++;
    }
  }

  return {
    newMembersInRange,
    newTrainersInRange,
    expectedRevenueThisMonth,
    expectedMemberCount,
    expectedInstallmentRowCount,
    collectedAmountThisMonth,
    collectedMemberCount,
    overdueAmount,
    pendingAmount,
    advanceAmount,
    overdueCount,
    pendingCount,
    advanceCount,
    overdueMemberCount: overdueCount,
    pendingMemberCount: pendingCount,
    advanceMemberCount: advanceCount,
    currency: DEFAULT_CURRENCY,
  };
}

export type DailyReceivedRow = {
  date: string;
  amount: number;
  /** Ledger rows (installments + one-time); same member paying twice ⇒ 2. */
  paymentCount: number;
  /** Distinct members with ≥1 collection that calendar day (gym TZ). */
  memberCount: number;
};

/**
 * Cash received from the fee collection ledger, grouped by gym-local calendar date of `collectedAt`.
 */
export async function getPaymentsReceivedDaily(
  gymId: number,
  startDate: string,
  endDate: string
): Promise<{ days: DailyReceivedRow[] }> {
  assertDateRangeOrder(startDate, endDate);
  const tz = getGymTimezone();

  const rangeStart = startOfGymCalendarDayUtc(startDate, tz);
  const rangeEndExclusive = startOfNextGymCalendarDayUtc(endDate, tz);

  const collections = await prisma.feeCollection.findMany({
    where: {
      gymId,
      collectedAt: { gte: rangeStart, lt: rangeEndExclusive },
    },
    select: { amount: true, collectedAt: true, memberId: true },
  });

  type DayAgg = { amount: number; paymentCount: number; memberIds: Set<number> };
  const byDay = new Map<string, DayAgg>();

  function touchDay(d: string): DayAgg {
    let row = byDay.get(d);
    if (!row) {
      row = { amount: 0, paymentCount: 0, memberIds: new Set<number>() };
      byDay.set(d, row);
    }
    return row;
  }

  for (const row of collections) {
    const d = calendarDateStringInGymTZ(row.collectedAt, tz);
    const agg = touchDay(d);
    agg.amount += row.amount;
    agg.paymentCount += 1;
    agg.memberIds.add(row.memberId);
  }

  const allDays = enumerateGymCalendarDaysInclusive(startDate, endDate, tz);
  const days: DailyReceivedRow[] = allDays.map((date) => {
    const row = byDay.get(date);
    return {
      date,
      amount: row?.amount ?? 0,
      paymentCount: row?.paymentCount ?? 0,
      memberCount: row?.memberIds.size ?? 0,
    };
  });

  return { days };
}
