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
  /** Sum of monthly installment `amount` for rows with payment.month === reportMonth (PAID+PENDING+OVERDUE). Excludes one-time/admission. */
  expectedRevenueThisMonth: number;
  overdueAmount: number;
  pendingAmount: number;
  advanceAmount: number;
  overdueCount: number;
  pendingCount: number;
  advanceCount: number;
  currency: string;
};

/**
 * expectedRevenueThisMonth: scheduled monthly fee installments for `reportMonth` (YYYY-MM),
 * regardless of paid status — matches the sum of `Payment.amount` where `month` = reportMonth.
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
      select: { amount: true },
    }),
    prisma.payment.findMany({
      where: {
        gymId,
        status: { in: ['PENDING', 'OVERDUE'] },
      },
      select: { amount: true, dueDate: true },
    }),
  ]);

  const expectedRevenueThisMonth = monthInstallments.reduce((s, p) => s + p.amount, 0);

  let overdueAmount = 0;
  let pendingAmount = 0;
  let advanceAmount = 0;
  let overdueCount = 0;
  let pendingCount = 0;
  let advanceCount = 0;

  for (const p of openInstallments) {
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
    overdueAmount,
    pendingAmount,
    advanceAmount,
    overdueCount,
    pendingCount,
    advanceCount,
    currency: DEFAULT_CURRENCY,
  };
}

export type DailyReceivedRow = {
  date: string;
  amount: number;
  paymentCount: number;
};

/**
 * Cash received: sum of amounts for monthly installments and one-time payments marked PAID,
 * grouped by gym-local calendar date of `paidDate`.
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

  const [monthlyPaid, oneTimePaid] = await Promise.all([
    prisma.payment.findMany({
      where: {
        gymId,
        status: 'PAID',
        paidDate: { not: null, gte: rangeStart, lt: rangeEndExclusive },
      },
      select: { amount: true, paidDate: true },
    }),
    prisma.oneTimePayment.findMany({
      where: {
        gymId,
        status: 'PAID',
        paidDate: { not: null, gte: rangeStart, lt: rangeEndExclusive },
      },
      select: { totalAmount: true, paidDate: true },
    }),
  ]);

  const byDay = new Map<string, { amount: number; paymentCount: number }>();

  for (const p of monthlyPaid) {
    if (!p.paidDate) {
      continue;
    }
    const d = calendarDateStringInGymTZ(p.paidDate, tz);
    const row = byDay.get(d) ?? { amount: 0, paymentCount: 0 };
    row.amount += p.amount;
    row.paymentCount += 1;
    byDay.set(d, row);
  }

  for (const p of oneTimePaid) {
    if (!p.paidDate) {
      continue;
    }
    const d = calendarDateStringInGymTZ(p.paidDate, tz);
    const row = byDay.get(d) ?? { amount: 0, paymentCount: 0 };
    row.amount += p.totalAmount;
    row.paymentCount += 1;
    byDay.set(d, row);
  }

  const allDays = enumerateGymCalendarDaysInclusive(startDate, endDate, tz);
  const days: DailyReceivedRow[] = allDays.map((date) => {
    const row = byDay.get(date);
    return {
      date,
      amount: row?.amount ?? 0,
      paymentCount: row?.paymentCount ?? 0,
    };
  });

  return { days };
}
