import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  parseDurationToMonths,
  formatMonth,
  nextBillingDueDate,
  getBillingAnchorDayUTC,
  computeMembershipLastDueDate,
  initialOpenInstallmentStatus,
  isDueCalendarDateBeforeTodayInGymTZ,
  unpaidInstallmentDisplayBucket,
  getGymTimezone,
  calendarDateStringInGymTZ,
  endOfCalendarMonthInGymTZ,
} from '../utils/dateHelpers';
import { NotFoundError, ValidationError } from '../utils/errors';

type Tx = Prisma.TransactionClient;

type MemberWithPackage = {
  packageId: number | null;
  membershipEnd: Date | null;
  membershipStart: Date | null;
  package: { price: number; discount: number | null; duration: string } | null;
};

function normalizeUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * Latest day through which a monthly installment may be scheduled: max(stored membershipEnd, package schedule end).
 * Fixes null/too-short membershipEnd blocking the next row after mark-paid.
 */
function resolveEffectiveMembershipEndDay(
  member: {
    membershipStart: Date | null;
    membershipEnd: Date | null;
    package: { duration: string } | null;
  },
  anchorDay: number
): Date | null {
  let best: Date | null = null;
  if (member.membershipEnd) {
    best = normalizeUtcDay(member.membershipEnd);
  }
  if (member.membershipStart && member.package) {
    const n = parseDurationToMonths(member.package.duration);
    if (n > 0) {
      const computed = computeMembershipLastDueDate(member.membershipStart, n, anchorDay);
      const cn = normalizeUtcDay(computed);
      if (!best || cn.getTime() > best.getTime()) {
        best = cn;
      }
    }
  }
  return best;
}

/**
 * Upper bound for creating/displaying open installments: later of package-derived end and
 * end of the **current** calendar month in GYM_TIMEZONE. Short packages (e.g. "2 months" ending Feb)
 * otherwise block March/April rows even when the member is still active on monthly fees.
 */
function resolveInstallmentSyncCapDay(
  member: {
    membershipStart: Date | null;
    membershipEnd: Date | null;
    package: { duration: string } | null;
  },
  anchorDay: number,
  tz: string
): Date | null {
  const packageEnd = resolveEffectiveMembershipEndDay(member, anchorDay);
  const throughCurrentMonth = endOfCalendarMonthInGymTZ(new Date(), tz);
  if (!packageEnd) {
    return throughCurrentMonth;
  }
  return packageEnd.getTime() > throughCurrentMonth.getTime() ? packageEnd : throughCurrentMonth;
}

/**
 * After the last PAID installment, materialize every missing monthly row up through the **current
 * calendar month** in GYM_TIMEZONE (not future billing months), bounded by effective membership end.
 * So if Feb is paid and today is April, creates March and April when missing — overdue/pending from DB rules.
 * Idempotent; safe on GET payments and after mark-paid.
 */
export async function syncMissingNextMonthlyInstallment(
  memberId: number,
  gymId: number
): Promise<void> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    include: { package: true },
  });

  if (!member?.packageId || !member.membershipStart || !member.package) {
    return;
  }

  const anchorDay = getBillingAnchorDayUTC(member.membershipStart);
  const tz = getGymTimezone();
  const syncCap = resolveInstallmentSyncCapDay(
    {
      membershipStart: member.membershipStart,
      membershipEnd: member.membershipEnd,
      package: member.package,
    },
    anchorDay,
    tz
  );
  if (!syncCap) {
    return;
  }

  const lastPaid = await prisma.payment.findFirst({
    where: { memberId, gymId, status: 'PAID' },
    orderBy: { dueDate: 'desc' },
  });
  if (!lastPaid) {
    return;
  }

  const todayStr = calendarDateStringInGymTZ(new Date(), tz);
  const todayYm = todayStr.slice(0, 7);

  const packagePrice = member.package.price;
  const discount = member.package.discount ?? 0;
  const amount = Math.max(0, packagePrice - discount);

  let d = nextBillingDueDate(lastPaid.dueDate, anchorDay);
  const maxSteps = 120;

  for (let step = 0; step < maxSteps; step++) {
    if (d.getTime() > syncCap.getTime()) {
      break;
    }

    const dueYm = calendarDateStringInGymTZ(d, tz).slice(0, 7);
    if (dueYm > todayYm) {
      break;
    }

    const monthKey = formatMonth(d);
    const existing = await prisma.payment.findFirst({
      where: { memberId, gymId, month: monthKey },
    });

    if (!existing) {
      const status = initialOpenInstallmentStatus(d, tz);
      await prisma.payment.create({
        data: {
          gymId,
          memberId,
          month: monthKey,
          amount,
          status,
          dueDate: d,
        },
      });
    }

    d = nextBillingDueDate(d, anchorDay);
  }
}

/**
 * After a monthly installment is marked paid, create the following month's row if within membership.
 */
export async function createNextInstallmentIfNeeded(
  db: Tx,
  gymId: number,
  paidPayment: {
    memberId: number;
    dueDate: Date;
    amount: number;
    member: MemberWithPackage;
  }
): Promise<void> {
  const { member } = paidPayment;
  if (!member.packageId || !member.package) {
    return;
  }

  const anchorDay = member.membershipStart
    ? getBillingAnchorDayUTC(member.membershipStart)
    : getBillingAnchorDayUTC(paidPayment.dueDate);
  const nextDueDate = nextBillingDueDate(paidPayment.dueDate, anchorDay);
  const nextMonth = formatMonth(nextDueDate);

  const existingPayment = await db.payment.findFirst({
    where: {
      memberId: paidPayment.memberId,
      gymId,
      month: nextMonth,
    },
  });

  const tz = getGymTimezone();
  const syncCap = resolveInstallmentSyncCapDay(
    {
      membershipStart: member.membershipStart,
      membershipEnd: member.membershipEnd,
      package: member.package,
    },
    anchorDay,
    tz
  );
  if (!syncCap) {
    return;
  }

  if (existingPayment || nextDueDate.getTime() > syncCap.getTime()) {
    return;
  }

  const packagePrice = member.package?.price ?? paidPayment.amount;
  const discount = member.package?.discount ?? 0;
  const amount = Math.max(0, packagePrice - discount);

  const status = initialOpenInstallmentStatus(nextDueDate, tz);

  await db.payment.create({
    data: {
      gymId,
      memberId: paidPayment.memberId,
      month: nextMonth,
      amount,
      status,
      dueDate: nextDueDate,
    },
  });
}

/**
 * Generate payments for a member based on their package.
 * Clears all unpaid installments (pending + overdue), then creates the first one from membership start.
 */
export async function generatePaymentsForMember(
  memberId: number,
  gymId: number,
  packageId: number | null,
  membershipStart: Date | null
): Promise<void> {
  if (!packageId || !membershipStart) {
    return;
  }

  const packageData = await prisma.package.findFirst({
    where: { id: packageId, gymId },
  });

  if (!packageData) {
    return;
  }

  const durationMonths = parseDurationToMonths(packageData.duration);
  if (durationMonths === 0) {
    return;
  }

  const anchorDay = getBillingAnchorDayUTC(membershipStart);
  const membershipEnd = computeMembershipLastDueDate(membershipStart, durationMonths, anchorDay);

  await prisma.payment.deleteMany({
    where: {
      memberId,
      gymId,
      status: { in: ['PENDING', 'OVERDUE'] },
    },
  });

  const tz = getGymTimezone();

  const currentDueDate = new Date(membershipStart);
  currentDueDate.setUTCHours(0, 0, 0, 0);

  const discount = packageData.discount ?? 0;
  const amount = Math.max(0, packageData.price - discount);

  const membershipEndNorm = new Date(membershipEnd);
  membershipEndNorm.setUTCHours(0, 0, 0, 0);

  if (currentDueDate <= membershipEndNorm) {
    const currentMonth = formatMonth(currentDueDate);

    const existingPayment = await prisma.payment.findFirst({
      where: {
        memberId,
        gymId,
        month: currentMonth,
      },
    });

    if (!existingPayment) {
      const status = initialOpenInstallmentStatus(currentDueDate, tz);

      await prisma.payment.create({
        data: {
          gymId,
          memberId,
          month: currentMonth,
          amount,
          status,
          dueDate: currentDueDate,
        },
      });
    } else if (
      existingPayment.status === 'PENDING' &&
      isDueCalendarDateBeforeTodayInGymTZ(currentDueDate, tz)
    ) {
      await prisma.payment.update({
        where: { id: existingPayment.id },
        data: { status: 'OVERDUE' },
      });
    }
  }

  await prisma.member.update({
    where: { id: memberId },
    data: {
      membershipEnd,
      monthlyPaymentAmount: amount,
    },
  });

  await ensureOpenMonthlyInstallmentExists({
    memberId,
    gymId,
    membershipEnd,
    amount,
  });
}

/**
 * After regenerating installments, if every unpaid row was removed but the membership is still active
 * and the anchor month is already PAID, create the next due row so the member never ends up with zero open installments.
 */
async function ensureOpenMonthlyInstallmentExists(params: {
  memberId: number;
  gymId: number;
  membershipEnd: Date;
  amount: number;
}): Promise<void> {
  const { memberId, gymId, membershipEnd, amount } = params;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const end = new Date(membershipEnd);
  end.setUTCHours(0, 0, 0, 0);
  if (end < today) {
    return;
  }

  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    select: { membershipStart: true },
  });
  if (!member?.membershipStart) {
    return;
  }

  const anchorDay = getBillingAnchorDayUTC(member.membershipStart);

  const open = await prisma.payment.findFirst({
    where: {
      memberId,
      gymId,
      status: { in: ['PENDING', 'OVERDUE'] },
    },
  });
  if (open) {
    return;
  }

  const lastPaid = await prisma.payment.findFirst({
    where: { memberId, gymId, status: 'PAID' },
    orderBy: { dueDate: 'desc' },
  });

  let nextDueDate: Date;
  if (lastPaid) {
    nextDueDate = nextBillingDueDate(lastPaid.dueDate, anchorDay);
  } else {
    nextDueDate = new Date(member.membershipStart);
    nextDueDate.setUTCHours(0, 0, 0, 0);
  }

  const maxSteps = 120;
  for (let step = 0; step < maxSteps; step++) {
    if (nextDueDate > end) {
      return;
    }

    const month = formatMonth(nextDueDate);
    const existing = await prisma.payment.findFirst({
      where: { memberId, gymId, month },
    });

    if (!existing) {
      const status = initialOpenInstallmentStatus(nextDueDate, getGymTimezone());
      await prisma.payment.create({
        data: {
          gymId,
          memberId,
          month,
          amount,
          status,
          dueDate: nextDueDate,
        },
      });
      return;
    }

    if (existing.status === 'PENDING' || existing.status === 'OVERDUE') {
      return;
    }

    nextDueDate = nextBillingDueDate(existing.dueDate, anchorDay);
  }
}

/**
 * Mark payment as paid and generate next payment if applicable
 */
export async function markPaymentAsPaid(paymentId: number, gymId: number): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, gymId },
    include: { member: { include: { package: true } } },
  });

  if (!payment) {
    throw new NotFoundError('Payment', paymentId);
  }

  const paidDate = new Date();
  paidDate.setUTCHours(0, 0, 0, 0);

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: 'PAID',
        paidDate,
      },
    });

    await createNextInstallmentIfNeeded(
      tx,
      gymId,
      {
        memberId: payment.memberId,
        dueDate: payment.dueDate,
        amount: payment.amount,
        member: {
          packageId: payment.member.packageId,
          membershipEnd: payment.member.membershipEnd,
          membershipStart: payment.member.membershipStart,
          package: payment.member.package,
        },
      }
    );
  });

  await syncMissingNextMonthlyInstallment(payment.memberId, gymId);
  await markOverduePayments(gymId);
}

/**
 * Mark multiple monthly installments paid in one action (same member, chronological order).
 * paidDate is set to start of today (UTC) for all.
 */
export async function markPaymentsAsPaidBulk(
  paymentIds: number[],
  gymId: number
): Promise<{ paidIds: number[] }> {
  const uniqueIds = [...new Set(paymentIds)];
  if (uniqueIds.length === 0) {
    throw new ValidationError('At least one payment ID is required');
  }

  const payments = await prisma.payment.findMany({
    where: { id: { in: uniqueIds }, gymId },
    include: { member: { include: { package: true } } },
  });

  if (payments.length !== uniqueIds.length) {
    throw new ValidationError('One or more payments were not found for this gym');
  }

  const memberIds = new Set(payments.map((p) => p.memberId));
  if (memberIds.size !== 1) {
    throw new ValidationError('All selected payments must belong to the same member');
  }

  for (const p of payments) {
    if (p.status === 'PAID') {
      throw new ValidationError(`Payment ${p.id} is already paid`);
    }
    if (p.status !== 'PENDING' && p.status !== 'OVERDUE') {
      throw new ValidationError(`Payment ${p.id} cannot be marked paid from status ${p.status}`);
    }
  }

  const sorted = [...payments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const paidDate = new Date();
  paidDate.setUTCHours(0, 0, 0, 0);

  await prisma.$transaction(async (tx) => {
    for (const p of sorted) {
      await tx.payment.update({
        where: { id: p.id },
        data: { status: 'PAID', paidDate },
      });

      await createNextInstallmentIfNeeded(tx, gymId, {
        memberId: p.memberId,
        dueDate: p.dueDate,
        amount: p.amount,
        member: {
          packageId: p.member.packageId,
          membershipEnd: p.member.membershipEnd,
          membershipStart: p.member.membershipStart,
          package: p.member.package,
        },
      });
    }
  });

  const mid = sorted[0].memberId;
  await syncMissingNextMonthlyInstallment(mid, gymId);
  await markOverduePayments(gymId);

  return { paidIds: sorted.map((p) => p.id) };
}

/**
 * Check and mark overdue payments
 */
export async function markOverduePayments(gymId: number): Promise<number> {
  const tz = getGymTimezone();
  const pending = await prisma.payment.findMany({
    where: { gymId, status: 'PENDING' },
    select: { id: true, dueDate: true },
  });
  const overdueIds = pending
    .filter((p) => isDueCalendarDateBeforeTodayInGymTZ(p.dueDate, tz))
    .map((p) => p.id);
  if (overdueIds.length === 0) {
    return 0;
  }
  const result = await prisma.payment.updateMany({
    where: { id: { in: overdueIds } },
    data: { status: 'OVERDUE' },
  });
  return result.count;
}

export type MemberPaymentSummaryRow = {
  member: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    packageId: number | null;
    membershipStart: Date | null;
    membershipEnd: Date | null;
    monthlyPaymentAmount: number | null;
  };
  nextUnpaid: null | {
    paymentId: number;
    amount: number;
    dueDate: Date;
    month: string;
    status: 'PENDING' | 'OVERDUE';
    isOverdue: boolean;
    displayBucket: 'overdue' | 'pending' | 'advance';
  };
  overdueMonthCount: number;
};

/**
 * Build one-row-per-member summaries for the main payment screen.
 */
export async function getMemberPaymentSummaries(
  gymId: number,
  options: {
    search?: string;
    onlyWithOpenInstallments?: boolean;
    page: number;
    limit: number;
    sortBy: 'name' | 'nextDueDate' | 'overdueCount';
    sortOrder: 'asc' | 'desc';
  }
): Promise<{ rows: MemberPaymentSummaryRow[]; total: number }> {
  await markOverduePayments(gymId);

  const { search, onlyWithOpenInstallments, page, limit, sortBy, sortOrder } = options;

  const memberWhere: Prisma.MemberWhereInput = { gymId };
  if (search?.trim()) {
    const s = search.trim();
    const searchNum = parseInt(s, 10);
    memberWhere.OR = [
      { name: { contains: s } },
      { email: { contains: s } },
      { phone: { contains: s } },
      ...(isNaN(searchNum) ? [] : [{ id: searchNum }]),
    ];
  }

  const members = await prisma.member.findMany({
    where: memberWhere,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      packageId: true,
      membershipStart: true,
      membershipEnd: true,
      monthlyPaymentAmount: true,
    },
    orderBy: { name: 'asc' },
  });

  const memberIds = members.map((m) => m.id);
  if (memberIds.length === 0) {
    return { rows: [], total: 0 };
  }

  const paidMemberRows = await prisma.payment.findMany({
    where: {
      gymId,
      memberId: { in: memberIds },
      status: 'PAID',
    },
    select: { memberId: true },
    distinct: ['memberId'],
  });
  const membersWithSomePaid = new Set(paidMemberRows.map((r) => r.memberId));

  const membersToChainSync = members.filter(
    (m) =>
      membersWithSomePaid.has(m.id) && m.packageId != null && m.membershipStart != null
  );
  for (const m of membersToChainSync) {
    await syncMissingNextMonthlyInstallment(m.id, gymId);
  }
  if (membersToChainSync.length > 0) {
    await markOverduePayments(gymId);
  }

  const unpaidPayments = await prisma.payment.findMany({
    where: {
      gymId,
      memberId: { in: memberIds },
      status: { in: ['PENDING', 'OVERDUE'] },
    },
    orderBy: { dueDate: 'asc' },
  });

  const tz = getGymTimezone();

  const unpaidByMember = new Map<number, typeof unpaidPayments>();
  for (const p of unpaidPayments) {
    const list = unpaidByMember.get(p.memberId) ?? [];
    list.push(p);
    unpaidByMember.set(p.memberId, list);
  }

  let rows: MemberPaymentSummaryRow[] = members.map((member) => {
    const list = unpaidByMember.get(member.id) ?? [];
    const next = list[0];
    const overdueMonthCount = list.filter((p) =>
      isDueCalendarDateBeforeTodayInGymTZ(p.dueDate, tz)
    ).length;

    return {
      member,
      nextUnpaid: next
        ? {
            paymentId: next.id,
            amount: next.amount,
            dueDate: next.dueDate,
            month: next.month,
            status: next.status as 'PENDING' | 'OVERDUE',
            isOverdue:
              next.status === 'OVERDUE' ||
              isDueCalendarDateBeforeTodayInGymTZ(next.dueDate, tz),
            displayBucket: unpaidInstallmentDisplayBucket(next.dueDate, tz),
          }
        : null,
      overdueMonthCount,
    };
  });

  if (onlyWithOpenInstallments) {
    rows = rows.filter((r) => r.nextUnpaid !== null);
  }

  const collator = sortOrder === 'asc' ? 1 : -1;

  rows.sort((a, b) => {
    if (sortBy === 'name') {
      return collator * a.member.name.localeCompare(b.member.name);
    }
    if (sortBy === 'overdueCount') {
      const diff = a.overdueMonthCount - b.overdueMonthCount;
      if (diff !== 0) {
        return collator * diff;
      }
      return a.member.name.localeCompare(b.member.name);
    }
    // nextDueDate
    const aTime = a.nextUnpaid?.dueDate.getTime() ?? Number.POSITIVE_INFINITY;
    const bTime = b.nextUnpaid?.dueDate.getTime() ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) {
      return collator * (aTime - bTime);
    }
    return a.member.name.localeCompare(b.member.name);
  });

  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);

  return { rows: paged, total };
}
