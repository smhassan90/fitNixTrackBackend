import { prisma } from '../lib/prisma';
import { ValidationError } from '../utils/errors';
import {
  calendarDateStringInGymTZ,
  getGymTimezone,
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
} from '../utils/dateHelpers';
import { getCollectedSummaryInDateRange } from './feeCollectionService';
import { getPaymentsReceivedDaily } from './reportService';
import { ensureDefaultExpenseCategories } from './expenseService';

const MONTH_RE = /^\d{4}-\d{2}$/;
const DEFAULT_CURRENCY = process.env.REPORT_CURRENCY?.trim() || 'PKR';

export type PaceProjection = {
  projectedIncome: number;
  projectedExpenses: number;
  projectedNet: number;
  dayOfMonth: number;
  daysInMonth: number;
};

export type DuesProjection = {
  expectedRemaining: number;
  projectedIncome: number;
  projectedExpenses: number;
  projectedNet: number;
};

export function daysInCalendarMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function lastCalendarDateOfMonth(month: string): string {
  return `${month}-${String(daysInCalendarMonth(month)).padStart(2, '0')}`;
}

export function resolvePnlDayOfMonth(month: string, todayYmd: string): number {
  const days = daysInCalendarMonth(month);
  const todayMonth = todayYmd.slice(0, 7);
  if (month < todayMonth) return days;
  if (month > todayMonth) return 0;
  return Math.min(days, Math.max(1, Number(todayYmd.slice(8, 10))));
}

export function computePaceProjection(input: {
  incomeSoFar: number;
  expensesSoFar: number;
  remainingRecurring: number;
  dayOfMonth: number;
  daysInMonth: number;
}): PaceProjection {
  const { incomeSoFar, expensesSoFar, remainingRecurring, dayOfMonth, daysInMonth } = input;
  const factor = dayOfMonth > 0 ? daysInMonth / dayOfMonth : 0;
  const projectedIncome = roundMoney(incomeSoFar * factor);
  const pacedExpenses = expensesSoFar * factor;
  const projectedExpenses = roundMoney(pacedExpenses + remainingRecurring);
  return {
    projectedIncome,
    projectedExpenses,
    projectedNet: roundMoney(projectedIncome - projectedExpenses),
    dayOfMonth,
    daysInMonth,
  };
}

export function computeDuesProjection(input: {
  incomeSoFar: number;
  expensesSoFar: number;
  expectedRemaining: number;
  remainingRecurring: number;
}): DuesProjection {
  const projectedIncome = roundMoney(input.incomeSoFar + input.expectedRemaining);
  const projectedExpenses = roundMoney(input.expensesSoFar + input.remainingRecurring);
  return {
    expectedRemaining: roundMoney(input.expectedRemaining),
    projectedIncome,
    projectedExpenses,
    projectedNet: roundMoney(projectedIncome - projectedExpenses),
  };
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export type PnlKindBreakdown = Record<'FIXED' | 'PETTY' | 'OTHER', number>;

export type PnlSummaryResult = {
  gymId: number;
  month: string;
  currency: string;
  incomeSoFar: number;
  membershipIncomeSoFar: number;
  posSalesSoFar: number;
  expensesSoFar: number;
  netSoFar: number;
  byKind: PnlKindBreakdown;
  byCategory: Array<{
    categoryId: number;
    name: string;
    kind: 'FIXED' | 'PETTY' | 'OTHER';
    amount: number;
  }>;
  remainingRecurring: number;
  paceProjection: PaceProjection;
  duesProjection: DuesProjection;
  dailyIncome: Array<{ date: string; amount: number; paymentCount: number; memberCount: number }>;
  productsSummary: {
    soldAmount: number;
    soldQuantity: number;
    items: Array<{
      productId: number;
      name: string;
      stockQuantity: number;
      soldQuantity: number;
      soldAmount: number;
    }>;
  };
  summary: {
    totalSales: number;
    fixed: number;
    petty: number;
    other: number;
    totalExpense: number;
    netIncome: number;
  };
};

export async function getPnlSummary(gymId: number, month?: string): Promise<PnlSummaryResult> {
  const tz = getGymTimezone();
  const todayYmd = calendarDateStringInGymTZ(new Date(), tz);
  const reportMonth = month || todayYmd.slice(0, 7);
  if (!MONTH_RE.test(reportMonth)) {
    throw new ValidationError('month must be YYYY-MM');
  }

  await ensureDefaultExpenseCategories(gymId);

  const startYmd = `${reportMonth}-01`;
  const endYmd = lastCalendarDateOfMonth(reportMonth);
  const rangeStart = startOfGymCalendarDayUtc(startYmd, tz);
  const rangeEndExclusive = startOfNextGymCalendarDayUtc(endYmd, tz);
  const days = daysInCalendarMonth(reportMonth);
  const dayOfMonth = resolvePnlDayOfMonth(reportMonth, todayYmd);

  const [
    collected,
    posAgg,
    posItems,
    posProducts,
    expenseRows,
    recurringHeads,
    unpaidInstallments,
    unpaidOneTime,
    daily,
  ] = await Promise.all([
    getCollectedSummaryInDateRange(gymId, rangeStart, rangeEndExclusive),
    prisma.posSale.aggregate({
      where: {
        gymId,
        status: 'COMPLETED',
        soldAt: { gte: rangeStart, lt: rangeEndExclusive },
      },
      _sum: { total: true },
    }),
    prisma.posSaleItem.findMany({
      where: {
        sale: {
          gymId,
          status: 'COMPLETED',
          soldAt: { gte: rangeStart, lt: rangeEndExclusive },
        },
      },
      select: { productId: true, productName: true, quantity: true, lineTotal: true },
    }),
    prisma.posProduct.findMany({
      where: { gymId, deletedAt: null, isActive: true },
      select: { id: true, name: true, stockQuantity: true },
      orderBy: { name: 'asc' },
    }),
    prisma.expenseEntry.findMany({
      where: { gymId, spentAt: { gte: rangeStart, lt: rangeEndExclusive } },
      select: {
        amount: true,
        categoryId: true,
        category: { select: { id: true, name: true, kind: true } },
      },
    }),
    prisma.expenseCategory.findMany({
      where: { gymId, isActive: true, deletedAt: null, isRecurring: true },
      select: { id: true, defaultAmount: true },
    }),
    prisma.payment.findMany({
      where: {
        gymId,
        status: { in: ['PENDING', 'OVERDUE'] },
        dueDate: { gte: rangeStart, lt: rangeEndExclusive },
      },
      select: { amount: true },
    }),
    prisma.oneTimePayment.findMany({
      where: {
        gymId,
        status: { in: ['PENDING', 'OVERDUE'] },
        createdAt: { gte: rangeStart, lt: rangeEndExclusive },
      },
      select: { totalAmount: true },
    }),
    getPaymentsReceivedDaily(gymId, startYmd, endYmd),
  ]);

  const membershipIncomeSoFar = roundMoney(collected.totalAmount);
  const posSalesSoFar = roundMoney(posAgg._sum.total ?? 0);
  const incomeSoFar = roundMoney(membershipIncomeSoFar + posSalesSoFar);

  const byKind: PnlKindBreakdown = { FIXED: 0, PETTY: 0, OTHER: 0 };
  const byCategoryMap = new Map<number, { categoryId: number; name: string; kind: 'FIXED' | 'PETTY' | 'OTHER'; amount: number }>();
  let expensesSoFar = 0;
  const bookedCategoryIds = new Set<number>();

  for (const row of expenseRows) {
    expensesSoFar += row.amount;
    byKind[row.category.kind] += row.amount;
    bookedCategoryIds.add(row.categoryId);
    const existing = byCategoryMap.get(row.categoryId);
    if (existing) {
      existing.amount += row.amount;
    } else {
      byCategoryMap.set(row.categoryId, {
        categoryId: row.category.id,
        name: row.category.name,
        kind: row.category.kind,
        amount: row.amount,
      });
    }
  }

  expensesSoFar = roundMoney(expensesSoFar);
  byKind.FIXED = roundMoney(byKind.FIXED);
  byKind.PETTY = roundMoney(byKind.PETTY);
  byKind.OTHER = roundMoney(byKind.OTHER);

  const remainingRecurring = roundMoney(
    recurringHeads.reduce((sum, head) => {
      if (bookedCategoryIds.has(head.id)) return sum;
      return sum + (head.defaultAmount ?? 0);
    }, 0)
  );

  const expectedRemaining = roundMoney(
    unpaidInstallments.reduce((s, p) => s + p.amount, 0) +
      unpaidOneTime.reduce((s, p) => s + p.totalAmount, 0)
  );

  const soldByProduct = new Map<number, { productId: number; name: string; soldQuantity: number; soldAmount: number }>();
  for (const item of posItems) {
    const cur = soldByProduct.get(item.productId) ?? {
      productId: item.productId,
      name: item.productName,
      soldQuantity: 0,
      soldAmount: 0,
    };
    cur.soldQuantity += item.quantity;
    cur.soldAmount += item.lineTotal;
    soldByProduct.set(item.productId, cur);
  }

  const productItems = posProducts.map((p) => {
    const sold = soldByProduct.get(p.id);
    return {
      productId: p.id,
      name: p.name,
      stockQuantity: p.stockQuantity,
      soldQuantity: sold?.soldQuantity ?? 0,
      soldAmount: roundMoney(sold?.soldAmount ?? 0),
    };
  });

  const paceProjection = computePaceProjection({
    incomeSoFar,
    expensesSoFar,
    remainingRecurring,
    dayOfMonth,
    daysInMonth: days,
  });
  const duesProjection = computeDuesProjection({
    incomeSoFar,
    expensesSoFar,
    expectedRemaining,
    remainingRecurring,
  });

  const netSoFar = roundMoney(incomeSoFar - expensesSoFar);
  const byCategory = [...byCategoryMap.values()]
    .map((row) => ({ ...row, amount: roundMoney(row.amount) }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

  return {
    gymId,
    month: reportMonth,
    currency: DEFAULT_CURRENCY,
    incomeSoFar,
    membershipIncomeSoFar,
    posSalesSoFar,
    expensesSoFar,
    netSoFar,
    byKind,
    byCategory,
    remainingRecurring,
    paceProjection,
    duesProjection,
    dailyIncome: daily.days,
    productsSummary: {
      soldAmount: posSalesSoFar,
      soldQuantity: posItems.reduce((s, i) => s + i.quantity, 0),
      items: productItems,
    },
    summary: {
      totalSales: incomeSoFar,
      fixed: byKind.FIXED,
      petty: byKind.PETTY,
      other: byKind.OTHER,
      totalExpense: expensesSoFar,
      netIncome: netSoFar,
    },
  };
}
