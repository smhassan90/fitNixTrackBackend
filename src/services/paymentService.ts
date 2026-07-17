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
  parseDate,
} from '../utils/dateHelpers';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  recordMonthlyFeeCollection,
  recordOneTimeFeeCollection,
  removeFeeCollectionBySource,
} from './feeCollectionService';

type Tx = Prisma.TransactionClient;

/**
 * First calendar day monthly billing is considered live for this deployment.
 * Admissions before this date are treated as pre-opening signup (admission fee only)
 * until billing resumes — they must not invent months of overdue.
 *
 * Override with GYM_OPERATIONS_START=YYYY-MM-DD when needed.
 */
export function getGymOperationsStartDate(): Date {
  const raw = process.env.GYM_OPERATIONS_START?.trim();
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return parseDate(raw);
  }
  return parseDate('2026-01-01');
}

/** Admission/join before gym monthly operations started. */
export function isPreOperationsAdmission(membershipStart: Date): boolean {
  const start = new Date(membershipStart);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime() < getGymOperationsStartDate().getTime();
}

/** True when paid/join month is before the current gym calendar month. */
export function isBeforeCurrentGymMonth(date: Date, now: Date = new Date()): boolean {
  const tz = getGymTimezone();
  const dateYm = calendarDateStringInGymTZ(date, tz).slice(0, 7);
  const todayYm = calendarDateStringInGymTZ(now, tz).slice(0, 7);
  return dateYm < todayYm;
}

/** First day of the current gym calendar month (UTC midnight). */
export function startOfCurrentGymMonth(now: Date = new Date()): Date {
  const tz = getGymTimezone();
  const todayStr = calendarDateStringInGymTZ(now, tz);
  return parseDate(`${todayStr.slice(0, 7)}-01`);
}

/**
 * After last PAID, choose the first due date sync may create.
 * Pre-operations admissions whose only paid row is the signup month jump to the
 * current gym month (or billingResumeFrom) — never invent a year of phantom overdue.
 * Post-operations members keep a normal month-to-month chain.
 */
export function resolveNextSyncDueAfterLastPaid(params: {
  lastPaidDueDate: Date;
  membershipStart: Date | null;
  billingResumeFrom: Date | null | undefined;
  anchorDay: number;
  now?: Date;
}): Date {
  const {
    lastPaidDueDate,
    membershipStart,
    billingResumeFrom,
    anchorDay,
    now = new Date(),
  } = params;

  let billableFrom = billingResumeFrom ?? null;
  const lastPaid = new Date(lastPaidDueDate);
  lastPaid.setUTCHours(0, 0, 0, 0);

  const isSignupSeedMonth =
    !!membershipStart && formatMonth(lastPaid) === formatMonth(membershipStart);

  if (
    !billableFrom &&
    membershipStart &&
    isPreOperationsAdmission(membershipStart) &&
    isSignupSeedMonth &&
    isBeforeCurrentGymMonth(lastPaid, now)
  ) {
    billableFrom = startOfCurrentGymMonth(now);
  }

  const d = nextBillingDueDate(lastPaid, anchorDay);
  return shiftToBillableDate(d, anchorDay, billableFrom);
}

/**
 * Unpaid rows that are phantom gaps from historical admission seeding — not real debt.
 * Only applies to pre-operations admissions (before GYM_OPERATIONS_START).
 * - Later PAID exists: unpaid months after admission month and before first later PAID,
 *   but only months that themselves fall before operations start.
 * - Only admission month PAID: unpaid before the current gym month (resume billing now).
 */
export function selectPhantomGapUnpaidPayments<
  T extends { status: string; dueDate: Date },
>(params: {
  membershipStart: Date;
  payments: T[];
  resumeFrom?: Date;
  now?: Date;
  operationsStart?: Date;
}): { gapUnpaid: T[]; setBillingResume: boolean } {
  const membershipStart = new Date(params.membershipStart);
  membershipStart.setUTCHours(0, 0, 0, 0);
  if (!isPreOperationsAdmission(membershipStart)) {
    return { gapUnpaid: [], setBillingResume: false };
  }

  const resumeFrom = params.resumeFrom ?? startOfCurrentGymMonth(params.now);
  const operationsStart = params.operationsStart ?? getGymOperationsStartDate();
  const payments = params.payments;

  const paid = payments.filter((p) => p.status === 'PAID');
  const month1Key = formatMonth(membershipStart);
  const month1Paid = paid.find((p) => formatMonth(p.dueDate) === month1Key);
  if (!month1Paid) {
    return { gapUnpaid: [], setBillingResume: false };
  }

  // Compare by calendar month, not dueDate > join day (join day-of-month can be 1
  // while due is the 31st of the same month).
  const paidAfterMonth1 = paid
    .filter((p) => formatMonth(p.dueDate) > month1Key)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  if (paidAfterMonth1.length > 0) {
    const firstLaterPaidMonth = formatMonth(paidAfterMonth1[0].dueDate);
    return {
      gapUnpaid: payments.filter((p) => {
        if (p.status !== 'OVERDUE' && p.status !== 'PENDING') return false;
        const ym = formatMonth(p.dueDate);
        return ym > month1Key && ym < firstLaterPaidMonth && p.dueDate.getTime() < operationsStart.getTime();
      }),
      setBillingResume: false,
    };
  }

  const onlyMonth1Paid = paid.length === 1;
  if (!onlyMonth1Paid) {
    return { gapUnpaid: [], setBillingResume: false };
  }

  const gapUnpaid = payments.filter((p) => {
    if (p.status !== 'OVERDUE' && p.status !== 'PENDING') return false;
    const ym = formatMonth(p.dueDate);
    return ym > month1Key && p.dueDate.getTime() < resumeFrom.getTime();
  });
  return { gapUnpaid, setBillingResume: gapUnpaid.length > 0 };
}

/**
 * After a historical signup seed (admission long before today), do not invent
 * every intervening month as OVERDUE. Resume monthly billing from the current
 * gym month and drop unpaid gap rows — but never delete unpaid that sits after
 * a real later PAID month (legitimate current overdue).
 */
async function resumeMonthlyBillingFromCurrentMonth(
  memberId: number,
  gymId: number,
  month1DueDate: Date
): Promise<Date | null> {
  const laterPaid = await prisma.payment.findFirst({
    where: {
      memberId,
      gymId,
      status: 'PAID',
      dueDate: { gt: month1DueDate },
    },
    orderBy: { dueDate: 'asc' },
    select: { dueDate: true },
  });

  if (laterPaid) {
    // Real billing already exists — only clear unpaid phantom gap before it.
    await prisma.payment.deleteMany({
      where: {
        memberId,
        gymId,
        status: { in: ['PENDING', 'OVERDUE'] },
        dueDate: {
          gt: month1DueDate,
          lt: laterPaid.dueDate,
        },
      },
    });
    return null;
  }

  const resumeFrom = startOfCurrentGymMonth();

  await prisma.member.update({
    where: { id: memberId },
    data: { billingResumeFrom: resumeFrom },
  });

  await prisma.payment.deleteMany({
    where: {
      memberId,
      gymId,
      status: { in: ['PENDING', 'OVERDUE'] },
      dueDate: {
        gt: month1DueDate,
        lt: resumeFrom,
      },
    },
  });

  return resumeFrom;
}

type MemberWithPackage = {
  packageId: number | null;
  membershipEnd: Date | null;
  membershipStart: Date | null;
  isActive?: boolean;
  billingResumeFrom?: Date | null;
  package: { price: number; discount: number | null; duration: string } | null;
};

/** Monthly package portion (annual plans divided by 12). */
export function computeMonthlyPackageFee(packageData: {
  price: number;
  discount: number | null;
  duration: string;
}): number {
  const packageDiscount = packageData.discount ?? 0;
  const net = Math.max(0, packageData.price - packageDiscount);
  const months = parseDurationToMonths(packageData.duration);
  return months === 12 ? net / 12 : net;
}

export function computeTrainerFeeFromTrainers(
  trainers: { charges: number | null }[]
): number {
  return trainers.reduce((sum, t) => sum + (t.charges ?? 0), 0);
}

/** Package + trainer fees minus member-level discount (matches portal monthly billing). */
export function computeMemberMonthlyInstallmentAmount(
  packageData: { price: number; discount: number | null; duration: string } | null,
  trainers: { charges: number | null }[],
  memberDiscount: number | null | undefined
): number {
  const packageFee = packageData ? computeMonthlyPackageFee(packageData) : 0;
  const trainerFee = computeTrainerFeeFromTrainers(trainers);
  return Math.max(0, packageFee + trainerFee - (memberDiscount ?? 0));
}

/** Signup one-time = admission + first month (monthly package + trainer − discount). */
export function computeSignupOneTimeFees(params: {
  admissionFeePaid: number;
  packageData: { price: number; discount: number | null; duration: string } | null;
  trainers: { charges: number | null }[];
  memberDiscount: number | null | undefined;
}): {
  admissionFee: number;
  packageFee: number;
  trainerFee: number;
  firstMonthRecurring: number;
  totalAmount: number;
  monthlyInstallmentAmount: number;
} {
  const monthlyPackageFee = params.packageData
    ? computeMonthlyPackageFee(params.packageData)
    : 0;
  const trainerFee = computeTrainerFeeFromTrainers(params.trainers);
  const monthlyInstallmentAmount = computeMemberMonthlyInstallmentAmount(
    params.packageData,
    params.trainers,
    params.memberDiscount
  );
  const firstMonthRecurring =
    params.packageData || trainerFee > 0 ? monthlyInstallmentAmount : 0;
  const totalAmount = params.admissionFeePaid + firstMonthRecurring;
  // First-month package portion after member discount so line items sum to totalAmount.
  const packageFee = Math.max(0, monthlyInstallmentAmount - trainerFee);

  return {
    admissionFee: params.admissionFeePaid,
    packageFee,
    trainerFee,
    firstMonthRecurring,
    totalAmount,
    monthlyInstallmentAmount,
  };
}

/** Ensure admission + package + trainer line items match total (legacy rows may omit member discount on packageFee). */
export function normalizeOneTimePaymentBreakdown(payment: {
  admissionFee: number;
  packageFee: number;
  trainerFee: number;
  totalAmount: number;
}): { admissionFee: number; packageFee: number; trainerFee: number; totalAmount: number } {
  const lineSum = payment.admissionFee + payment.packageFee + payment.trainerFee;
  if (Math.abs(lineSum - payment.totalAmount) < 0.01) {
    return payment;
  }
  const firstMonthRecurring = Math.max(0, payment.totalAmount - payment.admissionFee);
  return {
    ...payment,
    packageFee: Math.max(0, firstMonthRecurring - payment.trainerFee),
  };
}

export type PendingOneTimeSummary = {
  id: number;
  totalAmount: number;
  admissionFee: number;
  packageFee: number;
  trainerFee: number;
  status: 'PENDING';
};

export async function getPendingOneTimeByMemberIds(
  gymId: number,
  memberIds: number[]
): Promise<Map<number, PendingOneTimeSummary>> {
  const map = new Map<number, PendingOneTimeSummary>();
  if (memberIds.length === 0) {
    return map;
  }
  const rows = await prisma.oneTimePayment.findMany({
    where: {
      gymId,
      memberId: { in: memberIds },
      status: 'PENDING',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      memberId: true,
      totalAmount: true,
      admissionFee: true,
      packageFee: true,
      trainerFee: true,
      status: true,
    },
  });
  for (const row of rows) {
    if (!map.has(row.memberId)) {
      const normalized = normalizeOneTimePaymentBreakdown(row);
      map.set(row.memberId, {
        id: row.id,
        totalAmount: normalized.totalAmount,
        admissionFee: normalized.admissionFee,
        packageFee: normalized.packageFee,
        trainerFee: normalized.trainerFee,
        status: 'PENDING',
      });
    }
  }
  return map;
}

export async function assertNoPendingOneTimeBeforeMonthlyPay(
  memberId: number,
  gymId: number
): Promise<void> {
  const pending = await prisma.oneTimePayment.findFirst({
    where: { memberId, gymId, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) {
    throw new ValidationError(
      'Pay the signup one-time payment before monthly installments.'
    );
  }
}

/** Resolve historical paid date for signup — never defaults to today for migrated data. */
async function resolveSignupPaidDate(
  memberId: number,
  gymId: number,
  membershipStart: Date | null,
  explicit?: Date
): Promise<Date> {
  if (explicit) {
    const d = new Date(explicit);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (membershipStart) {
    const d = new Date(membershipStart);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const firstPaid = await prisma.payment.findFirst({
    where: { memberId, gymId, status: 'PAID', paidDate: { not: null } },
    orderBy: { paidDate: 'asc' },
    select: { paidDate: true },
  });
  if (firstPaid?.paidDate) {
    const d = new Date(firstPaid.paidDate);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Mark a pending signup one-time payment as PAID using a historical collected date
 * (membership start / first monthly paid date), so today's revenue is not inflated.
 */
export async function markSignupOneTimePaidAtDate(
  oneTimePaymentId: number,
  gymId: number,
  options: { paidDate?: Date; seedMonthly?: boolean } = {}
): Promise<{ memberId: number; paidDate: Date } | null> {
  const oneTimePayment = await prisma.oneTimePayment.findFirst({
    where: { id: oneTimePaymentId, gymId },
    include: {
      member: { select: { id: true, name: true, membershipStart: true } },
    },
  });

  if (!oneTimePayment) {
    return null;
  }
  if (oneTimePayment.status === 'PAID') {
    return {
      memberId: oneTimePayment.memberId,
      paidDate: oneTimePayment.paidDate ?? new Date(oneTimePayment.member.membershipStart ?? Date.now()),
    };
  }

  const paidDate = await resolveSignupPaidDate(
    oneTimePayment.memberId,
    gymId,
    oneTimePayment.member.membershipStart,
    options.paidDate
  );

  const billingMonth = oneTimePayment.member.membershipStart
    ? formatMonth(oneTimePayment.member.membershipStart)
    : formatMonth(paidDate);

  await prisma.$transaction(async (tx) => {
    await tx.oneTimePayment.update({
      where: { id: oneTimePaymentId },
      data: { status: 'PAID', paidDate },
    });
    await tx.member.update({
      where: { id: oneTimePayment.memberId },
      data: { oneTimePaymentPaid: true },
    });
    await recordOneTimeFeeCollection(tx, {
      gymId,
      memberId: oneTimePayment.memberId,
      memberName: oneTimePayment.member.name,
      oneTimePaymentId: oneTimePayment.id,
      admissionFee: oneTimePayment.admissionFee,
      packageFee: oneTimePayment.packageFee,
      trainerFee: oneTimePayment.trainerFee,
      totalAmount: oneTimePayment.totalAmount,
      collectedAt: paidDate,
      billingMonth,
    });
  });

  if (options.seedMonthly !== false) {
    await seedMonthlyBillingAfterOneTimePaid(oneTimePayment.memberId, gymId, { paidDate });
  }

  return { memberId: oneTimePayment.memberId, paidDate };
}

/** After signup one-time is paid, record month 1 as paid and open the next billable month. */
export async function seedMonthlyBillingAfterOneTimePaid(
  memberId: number,
  gymId: number,
  options: { paidDate?: Date } = {}
): Promise<void> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    include: { package: true },
  });
  if (!member?.packageId || !member.membershipStart || !member.package) {
    return;
  }

  const amount = await refreshMemberOpenInstallmentAmounts(memberId, gymId);
  const month1Key = formatMonth(member.membershipStart);
  const dueDate = new Date(member.membershipStart);
  dueDate.setUTCHours(0, 0, 0, 0);

  const paidDate = options.paidDate
    ? new Date(options.paidDate)
    : new Date(member.membershipStart);
  paidDate.setUTCHours(0, 0, 0, 0);

  // Pre-opening admission: keep signup revenue on the join date, but do not
  // backfill every month since then as overdue (gym was not operating yet).
  const historicalSignup = isPreOperationsAdmission(dueDate);
  let billingResumeFrom = member.billingResumeFrom;
  let skipCreateNextFromMonth1 = false;
  if (historicalSignup) {
    const resumed = await resumeMonthlyBillingFromCurrentMonth(memberId, gymId, dueDate);
    if (resumed) {
      billingResumeFrom = resumed;
    } else {
      // Real monthly PAID rows already exist after admission — do not open Feb from month 1.
      skipCreateNextFromMonth1 = true;
    }
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findFirst({
      where: { memberId, gymId, month: month1Key },
    });

    let month1Paid = existing;
    if (!existing) {
      month1Paid = await tx.payment.create({
        data: {
          gymId,
          memberId,
          month: month1Key,
          amount,
          status: 'PAID',
          dueDate,
          paidDate,
        },
      });
    } else if (existing.status !== 'PAID') {
      month1Paid = await tx.payment.update({
        where: { id: existing.id },
        data: { status: 'PAID', paidDate, amount },
      });
    }

    if (month1Paid && !skipCreateNextFromMonth1) {
      await createNextInstallmentIfNeeded(tx, gymId, {
        memberId,
        dueDate: month1Paid.dueDate,
        amount: month1Paid.amount,
        member: {
          packageId: member.packageId,
          membershipEnd: member.membershipEnd,
          membershipStart: member.membershipStart,
          isActive: member.isActive,
          billingResumeFrom,
          package: member.package,
        },
      });
    }
  });

  await syncMissingNextMonthlyInstallment(memberId, gymId);
  await markOverduePayments(gymId);
}

/**
 * Repair members damaged by historical signup seed + overdue backfill.
 *
 * Two patterns:
 * 1) Only admission month PAID, then many OVERDUE through today (e.g. Sufiyan) —
 *    drop gap unpaid and resume billing from the current gym month.
 * 2) Admission month PAID, later months truly PAID, but phantom OVERDUE in the
 *    gap before real billing (e.g. Sarwar 2025-02) — drop only that gap.
 *
 * Also reactivates members auto-marked inactive (inactiveFrom ≠ join month).
 */
export async function repairHistoricalSignupOverdueBackfill(
  gymId: number,
  options: { dryRun?: boolean; reactivateAutoInactive?: boolean } = {}
): Promise<{
  scanned: number;
  repaired: number;
  reactivated: number;
  skipped: number;
  members: Array<{
    memberId: number;
    legacyMemberId: string | null;
    name: string;
    overdueRemoved: number;
    reactivated: boolean;
  }>;
}> {
  const dryRun = options.dryRun === true;
  const reactivateAutoInactive = options.reactivateAutoInactive !== false;
  const resumeFrom = startOfCurrentGymMonth();

  const candidates = await prisma.member.findMany({
    where: {
      gymId,
      oneTimePaymentPaid: true,
      membershipStart: { not: null },
    },
    select: {
      id: true,
      legacyMemberId: true,
      name: true,
      isActive: true,
      inactiveFrom: true,
      membershipStart: true,
      membershipEnd: true,
      billingResumeFrom: true,
      package: { select: { duration: true } },
    },
  });

  const result: {
    scanned: number;
    repaired: number;
    reactivated: number;
    skipped: number;
    members: Array<{
      memberId: number;
      legacyMemberId: string | null;
      name: string;
      overdueRemoved: number;
      reactivated: boolean;
    }>;
  } = {
    scanned: candidates.length,
    repaired: 0,
    reactivated: 0,
    skipped: 0,
    members: [],
  };

  for (const member of candidates) {
    if (!member.membershipStart || !isPreOperationsAdmission(member.membershipStart)) {
      result.skipped++;
      continue;
    }

    const month1Key = formatMonth(member.membershipStart);
    const payments = await prisma.payment.findMany({
      where: { memberId: member.id, gymId },
      select: { id: true, month: true, status: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
    });

    const month1Due = new Date(member.membershipStart);
    month1Due.setUTCHours(0, 0, 0, 0);

    const { gapUnpaid, setBillingResume } = selectPhantomGapUnpaidPayments({
      membershipStart: member.membershipStart,
      payments,
      resumeFrom,
    });

    if (gapUnpaid.length === 0) {
      result.skipped++;
      continue;
    }

    const importedInactive =
      !member.isActive &&
      member.inactiveFrom &&
      formatMonth(member.inactiveFrom) === month1Key;
    // Only reactivate when we are also clearing phantom overdue — do not undo
    // legitimate absence/manual deactivations with clean payment history.
    const shouldReactivate =
      reactivateAutoInactive &&
      !member.isActive &&
      !importedInactive;

    const staleMembershipEnd =
      !member.membershipEnd || member.membershipEnd.getTime() <= month1Due.getTime();

    const paidAfterMonth1 = payments.filter(
      (p) => p.status === 'PAID' && p.dueDate.getTime() > month1Due.getTime()
    );

    if (dryRun) {
      result.repaired++;
      if (shouldReactivate) result.reactivated++;
      result.members.push({
        memberId: member.id,
        legacyMemberId: member.legacyMemberId,
        name: member.name,
        overdueRemoved: gapUnpaid.length,
        reactivated: shouldReactivate,
      });
      continue;
    }

    let newMembershipEnd: Date | undefined;
    if ((shouldReactivate || setBillingResume) && staleMembershipEnd && member.package) {
      const anchorDay = getBillingAnchorDayUTC(member.membershipStart);
      const durationMonths = parseDurationToMonths(member.package.duration);
      if (durationMonths > 0) {
        const from = setBillingResume ? resumeFrom : paidAfterMonth1[0]?.dueDate ?? resumeFrom;
        newMembershipEnd = computeMembershipLastDueDate(from, durationMonths, anchorDay);
      } else {
        newMembershipEnd = endOfCalendarMonthInGymTZ(new Date());
      }
    }

    await prisma.member.update({
      where: { id: member.id },
      data: {
        ...(setBillingResume ? { billingResumeFrom: resumeFrom } : {}),
        ...(shouldReactivate ? { isActive: true, inactiveFrom: null } : {}),
        ...(newMembershipEnd ? { membershipEnd: newMembershipEnd } : {}),
      },
    });

    if (gapUnpaid.length > 0) {
      await prisma.payment.deleteMany({
        where: { id: { in: gapUnpaid.map((p) => p.id) } },
      });
    }

    if (shouldReactivate || member.isActive) {
      await syncMissingNextMonthlyInstallment(member.id, gymId);
    }
    await markOverduePayments(gymId);

    result.repaired++;
    if (shouldReactivate) result.reactivated++;
    result.members.push({
      memberId: member.id,
      legacyMemberId: member.legacyMemberId,
      name: member.name,
      overdueRemoved: gapUnpaid.length,
      reactivated: shouldReactivate,
    });
  }

  return result;
}

/**
 * Undo accidental "resume from current month" for members who joined on/after
 * gym operations start. Clears billingResumeFrom and re-syncs the real overdue chain
 * from their last PAID installment.
 */
export async function restorePostOperationsBillingAfterWrongResume(
  gymId: number,
  options: { dryRun?: boolean } = {}
): Promise<{
  scanned: number;
  restored: number;
  members: Array<{
    memberId: number;
    legacyMemberId: string | null;
    name: string;
    membershipStart: string;
  }>;
}> {
  const dryRun = options.dryRun === true;
  const operationsStart = getGymOperationsStartDate();

  const candidates = await prisma.member.findMany({
    where: {
      gymId,
      billingResumeFrom: { not: null },
      membershipStart: { gte: operationsStart },
      isActive: true,
    },
    select: {
      id: true,
      legacyMemberId: true,
      name: true,
      membershipStart: true,
      billingResumeFrom: true,
    },
  });

  const result: {
    scanned: number;
    restored: number;
    members: Array<{
      memberId: number;
      legacyMemberId: string | null;
      name: string;
      membershipStart: string;
    }>;
  } = { scanned: candidates.length, restored: 0, members: [] };

  for (const member of candidates) {
    if (!member.membershipStart) continue;

    const paid = await prisma.payment.findMany({
      where: { memberId: member.id, gymId, status: 'PAID' },
      select: { month: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
    });
    const month1Key = formatMonth(member.membershipStart);
    const onlyAdmissionPaid =
      paid.length === 1 && formatMonth(paid[0].dueDate) === month1Key;
    if (!onlyAdmissionPaid) {
      continue;
    }

    result.members.push({
      memberId: member.id,
      legacyMemberId: member.legacyMemberId,
      name: member.name,
      membershipStart: member.membershipStart.toISOString().slice(0, 10),
    });

    if (dryRun) {
      result.restored++;
      continue;
    }

    await prisma.member.update({
      where: { id: member.id },
      data: { billingResumeFrom: null },
    });
    await syncMissingNextMonthlyInstallment(member.id, gymId);
    await markOverduePayments(gymId);
    result.restored++;
  }

  return result;
}

async function resolveMonthlyInstallmentAmount(
  db: Tx | typeof prisma,
  memberId: number,
  gymId: number
): Promise<number> {
  const member = await db.member.findFirst({
    where: { id: memberId, gymId },
    include: {
      package: true,
      trainers: {
        include: {
          trainer: { select: { charges: true } },
        },
      },
    },
  });
  if (!member) {
    return 0;
  }
  const trainerList = member.trainers.map((mt) => mt.trainer);
  return computeMemberMonthlyInstallmentAmount(member.package, trainerList, member.discount);
}

/** Align open installment amounts and stored monthly fee with package + trainer + discount. */
export async function refreshMemberOpenInstallmentAmounts(
  memberId: number,
  gymId: number,
  db: Tx | typeof prisma = prisma
): Promise<number> {
  const amount = await resolveMonthlyInstallmentAmount(db, memberId, gymId);
  await db.member.update({
    where: { id: memberId },
    data: { monthlyPaymentAmount: amount },
  });
  await db.payment.updateMany({
    where: {
      memberId,
      gymId,
      status: { in: ['PENDING', 'OVERDUE'] },
    },
    data: { amount },
  });
  return amount;
}

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

  if (!member?.packageId || !member.membershipStart || !member.package || !member.isActive) {
    return;
  }

  const amount = await refreshMemberOpenInstallmentAmounts(memberId, gymId);

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

  let d = resolveNextSyncDueAfterLastPaid({
    lastPaidDueDate: lastPaid.dueDate,
    membershipStart: member.membershipStart,
    billingResumeFrom: member.billingResumeFrom,
    anchorDay,
  });
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

function endOfUtcMonthFromYearMonthKey(ym: string): Date {
  const [y, mo] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo, 0));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function shiftToBillableDate(
  dueDate: Date,
  anchorDay: number,
  billableFrom: Date | null | undefined
): Date {
  if (!billableFrom) {
    return dueDate;
  }
  const from = new Date(billableFrom);
  from.setUTCHours(0, 0, 0, 0);
  let d = new Date(dueDate);
  d.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 120 && d.getTime() < from.getTime(); i++) {
    d = nextBillingDueDate(d, anchorDay);
  }
  return d;
}

/**
 * Materialize missing rows after last PAID through target YYYY-MM (inclusive), so advance months can be marked paid.
 * Bounded by max(syncCap, end of target month).
 */
export async function ensureMonthlyInstallmentsThroughMonthKey(
  memberId: number,
  gymId: number,
  targetMonthKey: string
): Promise<void> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    include: { package: true },
  });

  if (!member?.packageId || !member.membershipStart || !member.package || !member.isActive) {
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

  const targetEnd = endOfUtcMonthFromYearMonthKey(targetMonthKey);
  const endCap = new Date(Math.max(syncCap.getTime(), targetEnd.getTime()));

  const lastPaid = await prisma.payment.findFirst({
    where: { memberId, gymId, status: 'PAID' },
    orderBy: { dueDate: 'desc' },
  });
  if (!lastPaid) {
    return;
  }

  const amount = await refreshMemberOpenInstallmentAmounts(memberId, gymId);

  let d = resolveNextSyncDueAfterLastPaid({
    lastPaidDueDate: lastPaid.dueDate,
    membershipStart: member.membershipStart,
    billingResumeFrom: member.billingResumeFrom,
    anchorDay,
  });

  for (let step = 0; step < 120; step++) {
    if (d.getTime() > endCap.getTime()) {
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

    if (monthKey >= targetMonthKey) {
      break;
    }

    d = nextBillingDueDate(d, anchorDay);
  }
}

/**
 * Sync + ensure rows through month, then mark that installment paid. Used by member and payment routes.
 */
export async function markMonthlyInstallmentByYearMonth(
  gymId: number,
  memberId: number,
  monthKey: string
) {
  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    select: { id: true },
  });
  if (!member) {
    throw new NotFoundError('Member', String(memberId));
  }

  await markOverduePayments(gymId);
  await syncMissingNextMonthlyInstallment(memberId, gymId);
  await ensureMonthlyInstallmentsThroughMonthKey(memberId, gymId, monthKey);
  await markOverduePayments(gymId);

  const payment = await prisma.payment.findFirst({
    where: { gymId, memberId, month: monthKey },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  if (!payment) {
    throw new NotFoundError('Monthly payment', `${memberId}/${monthKey}`);
  }
  if (payment.status === 'PAID') {
    throw new ValidationError(`Month ${monthKey} is already marked paid`);
  }

  await assertNoPendingOneTimeBeforeMonthlyPay(memberId, gymId);

  await markPaymentAsPaid(payment.id, gymId);

  const updated = await prisma.payment.findFirst({
    where: { id: payment.id, gymId },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  return updated;
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
  if (!member.packageId || !member.package || member.isActive === false) {
    return;
  }

  const anchorDay = member.membershipStart
    ? getBillingAnchorDayUTC(member.membershipStart)
    : getBillingAnchorDayUTC(paidPayment.dueDate);
  let nextDueDate = nextBillingDueDate(paidPayment.dueDate, anchorDay);
  nextDueDate = shiftToBillableDate(nextDueDate, anchorDay, member.billingResumeFrom);
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

  const amount = await resolveMonthlyInstallmentAmount(db, paidPayment.memberId, gymId);

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
  membershipStart: Date | null,
  options?: { skipFirstInstallment?: boolean }
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

  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    include: {
      trainers: {
        include: {
          trainer: { select: { charges: true } },
        },
      },
    },
  });

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

  const trainerList = member?.trainers?.map((mt) => mt.trainer) ?? [];
  const amount = computeMemberMonthlyInstallmentAmount(
    packageData,
    trainerList,
    member?.discount
  );

  const membershipEndNorm = new Date(membershipEnd);
  membershipEndNorm.setUTCHours(0, 0, 0, 0);

  const skipFirstInstallment = options?.skipFirstInstallment === true;

  if (!skipFirstInstallment && currentDueDate <= membershipEndNorm) {
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

  if (!skipFirstInstallment) {
    await ensureOpenMonthlyInstallmentExists({
      memberId,
      gymId,
      membershipEnd,
      amount,
    });
  }

  await refreshMemberOpenInstallmentAmounts(memberId, gymId);
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
    select: { membershipStart: true, billingResumeFrom: true, isActive: true },
  });
  if (!member?.membershipStart || !member.isActive) {
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
  nextDueDate = shiftToBillableDate(nextDueDate, anchorDay, member.billingResumeFrom);

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
 * Enforce chronological pay order: overdue months first, then pending/advance.
 * Targets must be the first N unpaid installments for the member (no skipping).
 */
async function assertInstallmentsPayableInOrder(
  memberId: number,
  gymId: number,
  paymentIds: number[]
): Promise<void> {
  const uniqueIds = [...new Set(paymentIds)];
  if (uniqueIds.length === 0) {
    throw new ValidationError('At least one payment ID is required');
  }

  const unpaid = await prisma.payment.findMany({
    where: {
      memberId,
      gymId,
      status: { in: ['PENDING', 'OVERDUE'] },
    },
    orderBy: { dueDate: 'asc' },
  });

  const targets = await prisma.payment.findMany({
    where: { id: { in: uniqueIds }, gymId, memberId },
    orderBy: { dueDate: 'asc' },
  });

  if (targets.length !== uniqueIds.length) {
    throw new ValidationError('One or more payments were not found for this member');
  }

  const expected = unpaid.slice(0, targets.length);
  const matchesPrefix =
    expected.length === targets.length &&
    expected.every((exp, idx) => exp.id === targets[idx].id);

  if (matchesPrefix) return;

  const tz = getGymTimezone();
  const hasOverdue = unpaid.some(
    (p) => p.status === 'OVERDUE' || isDueCalendarDateBeforeTodayInGymTZ(p.dueDate, tz)
  );
  const targetHasPendingOrAdvance = targets.some((p) => {
    const isOverdue =
      p.status === 'OVERDUE' || isDueCalendarDateBeforeTodayInGymTZ(p.dueDate, tz);
    return !isOverdue;
  });

  if (hasOverdue && targetHasPendingOrAdvance) {
    throw new ValidationError(
      'Clear all overdue installments before paying pending or advance months.'
    );
  }

  const earliest = unpaid[0];
  throw new ValidationError(
    `Pay installments in order starting from ${earliest?.month ?? 'the oldest due date'}.`
  );
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

  if (payment.status === 'PAID') {
    throw new ValidationError('Payment is already marked paid');
  }

  await assertNoPendingOneTimeBeforeMonthlyPay(payment.memberId, gymId);

  await assertInstallmentsPayableInOrder(payment.memberId, gymId, [paymentId]);

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

    await recordMonthlyFeeCollection(tx, {
      gymId,
      memberId: payment.memberId,
      memberName: payment.member.name,
      paymentId,
      amount: payment.amount,
      billingMonth: payment.month,
      collectedAt: paidDate,
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
          isActive: payment.member.isActive,
          billingResumeFrom: payment.member.billingResumeFrom,
          package: payment.member.package,
        },
      }
    );
  });

  await syncMissingNextMonthlyInstallment(payment.memberId, gymId);
  await markOverduePayments(gymId);
}

/**
 * Revert a monthly installment from PAID to open status. Only allowed for the member's **latest**
 * PAID row by `dueDate` (then `id`) — LIFO so mistakes are undone one billing month at a time.
 * Drops unpaid future rows (PENDING/OVERDUE with dueDate after this one) created by the pay chain.
 */
export async function markLastPaidInstallmentUnpaid(paymentId: number, gymId: number) {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, gymId },
  });

  if (!payment) {
    throw new NotFoundError('Payment', paymentId);
  }

  if (payment.status !== 'PAID') {
    throw new ValidationError('Only paid installments can be marked unpaid');
  }

  const lastPaid = await prisma.payment.findFirst({
    where: { memberId: payment.memberId, gymId, status: 'PAID' },
    orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
  });

  if (!lastPaid || lastPaid.id !== paymentId) {
    throw new ValidationError(
      'Only the latest paid installment (by billing date) can be marked unpaid. Unmark more recent payments first.'
    );
  }

  const tz = getGymTimezone();
  const newStatus = initialOpenInstallmentStatus(payment.dueDate, tz);

  await prisma.$transaction(async (tx) => {
    await tx.payment.deleteMany({
      where: {
        memberId: payment.memberId,
        gymId,
        status: { in: ['PENDING', 'OVERDUE'] },
        dueDate: { gt: payment.dueDate },
      },
    });

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: newStatus,
        paidDate: null,
      },
    });

    await removeFeeCollectionBySource(tx, 'MONTHLY_PAYMENT', paymentId, gymId);
  });

  await syncMissingNextMonthlyInstallment(payment.memberId, gymId);
  await markOverduePayments(gymId);

  return prisma.payment.findFirst({
    where: { id: paymentId, gymId },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
    },
  });
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

  await assertInstallmentsPayableInOrder(payments[0].memberId, gymId, uniqueIds);
  await assertNoPendingOneTimeBeforeMonthlyPay(payments[0].memberId, gymId);

  const sorted = [...payments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const paidDate = new Date();
  paidDate.setUTCHours(0, 0, 0, 0);

  await prisma.$transaction(async (tx) => {
    for (const p of sorted) {
      await tx.payment.update({
        where: { id: p.id },
        data: { status: 'PAID', paidDate },
      });

      await recordMonthlyFeeCollection(tx, {
        gymId,
        memberId: p.memberId,
        memberName: p.member.name,
        paymentId: p.id,
        amount: p.amount,
        billingMonth: p.month,
        collectedAt: paidDate,
      });

      await createNextInstallmentIfNeeded(tx, gymId, {
        memberId: p.memberId,
        dueDate: p.dueDate,
        amount: p.amount,
        member: {
          packageId: p.member.packageId,
          membershipEnd: p.member.membershipEnd,
          membershipStart: p.member.membershipStart,
          isActive: p.member.isActive,
          billingResumeFrom: p.member.billingResumeFrom,
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
    select: { id: true, dueDate: true, member: { select: { isActive: true } } },
  });
  const overdueIds = pending
    .filter((p) => p.member.isActive && isDueCalendarDateBeforeTodayInGymTZ(p.dueDate, tz))
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
    legacyMemberId: string | null;
    memberNumber: string | null;
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
  nextOneTime: PendingOneTimeSummary | null;
};

const MEMBER_SUMMARY_SELECT = {
  id: true,
  legacyMemberId: true,
  name: true,
  email: true,
  phone: true,
  packageId: true,
  membershipStart: true,
  membershipEnd: true,
  monthlyPaymentAmount: true,
} as const;

function buildMemberSummaryWhere(
  gymId: number,
  search?: string,
  onlyWithOpenInstallments?: boolean
): Prisma.MemberWhereInput {
  const and: Prisma.MemberWhereInput[] = [{ gymId }];

  if (search?.trim()) {
    const s = search.trim();
    const searchNum = parseInt(s, 10);
    and.push({
      OR: [
        { name: { contains: s } },
        { email: { contains: s } },
        { phone: { contains: s } },
        { legacyMemberId: { contains: s } },
        ...(isNaN(searchNum) ? [] : [{ id: searchNum }, { legacyMemberId: s }]),
      ],
    });
  }

  if (onlyWithOpenInstallments) {
    and.push({
      OR: [
        {
          payments: {
            some: {
              gymId,
              status: { in: ['PENDING', 'OVERDUE'] },
            },
          },
        },
        {
          oneTimePayments: {
            some: {
              gymId,
              status: 'PENDING',
            },
          },
        },
      ],
    });
  }

  return and.length === 1 ? and[0] : { AND: and };
}

/** Refresh installment amounts / missing months for members on the current page only. */
async function syncMembersForPaymentSummary(gymId: number, memberIds: number[]): Promise<void> {
  if (memberIds.length === 0) {
    return;
  }

  const members = await prisma.member.findMany({
    where: { id: { in: memberIds }, gymId },
    select: { id: true, packageId: true, membershipStart: true },
  });

  const paidMemberRows = await prisma.payment.findMany({
    where: { gymId, memberId: { in: memberIds }, status: 'PAID' },
    select: { memberId: true },
    distinct: ['memberId'],
  });
  const membersWithSomePaid = new Set(paidMemberRows.map((r) => r.memberId));

  for (const m of members.filter((row) => row.packageId != null)) {
    await refreshMemberOpenInstallmentAmounts(m.id, gymId);
  }

  const membersToChainSync = members.filter(
    (m) => membersWithSomePaid.has(m.id) && m.packageId != null && m.membershipStart != null
  );
  for (const m of membersToChainSync) {
    await syncMissingNextMonthlyInstallment(m.id, gymId);
  }
  if (membersToChainSync.length > 0) {
    await markOverduePayments(gymId);
  }
}

async function buildSummaryRowsForMembers(
  gymId: number,
  members: Array<{
    id: number;
    legacyMemberId: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    packageId: number | null;
    membershipStart: Date | null;
    membershipEnd: Date | null;
    monthlyPaymentAmount: number | null;
  }>
): Promise<MemberPaymentSummaryRow[]> {
  const memberIds = members.map((m) => m.id);
  if (memberIds.length === 0) {
    return [];
  }

  const unpaidPayments = await prisma.payment.findMany({
    where: {
      gymId,
      memberId: { in: memberIds },
      status: { in: ['PENDING', 'OVERDUE'] },
    },
    orderBy: { dueDate: 'asc' },
  });

  const pendingOneTimeByMember = await getPendingOneTimeByMemberIds(gymId, memberIds);
  const tz = getGymTimezone();

  const unpaidByMember = new Map<number, typeof unpaidPayments>();
  for (const p of unpaidPayments) {
    const list = unpaidByMember.get(p.memberId) ?? [];
    list.push(p);
    unpaidByMember.set(p.memberId, list);
  }

  return members.map((member) => {
    const list = unpaidByMember.get(member.id) ?? [];
    const next = list[0];
    const overdueMonthCount = list.filter((p) =>
      isDueCalendarDateBeforeTodayInGymTZ(p.dueDate, tz)
    ).length;

    return {
      member: {
        ...member,
        memberNumber: member.legacyMemberId?.trim() || null,
      },
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
      nextOneTime: pendingOneTimeByMember.get(member.id) ?? null,
    };
  });
}

/**
 * Build one-row-per-member summaries for the main payment screen.
 * Paginates at the database level and only syncs billing for the current page.
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
  const memberWhere = buildMemberSummaryWhere(gymId, search, onlyWithOpenInstallments);
  const collator = sortOrder === 'asc' ? 1 : -1;

  if (sortBy === 'name') {
    const total = await prisma.member.count({ where: memberWhere });
    const members = await prisma.member.findMany({
      where: memberWhere,
      select: MEMBER_SUMMARY_SELECT,
      orderBy: { name: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    });

    await syncMembersForPaymentSummary(
      gymId,
      members.map((m) => m.id)
    );
    const rows = await buildSummaryRowsForMembers(gymId, members);
    return { rows, total };
  }

  const matchingMembers = await prisma.member.findMany({
    where: memberWhere,
    select: { id: true, name: true },
  });

  if (matchingMembers.length === 0) {
    return { rows: [], total: 0 };
  }

  const memberIds = matchingMembers.map((m) => m.id);
  const unpaidPayments = await prisma.payment.findMany({
    where: {
      gymId,
      memberId: { in: memberIds },
      status: { in: ['PENDING', 'OVERDUE'] },
    },
    select: { memberId: true, dueDate: true, status: true },
    orderBy: { dueDate: 'asc' },
  });

  const tz = getGymTimezone();

  const unpaidByMember = new Map<number, typeof unpaidPayments>();
  for (const p of unpaidPayments) {
    const list = unpaidByMember.get(p.memberId) ?? [];
    list.push(p);
    unpaidByMember.set(p.memberId, list);
  }

  type SortMetric = {
    memberId: number;
    name: string;
    nextDueTime: number;
    overdueCount: number;
  };

  const metrics: SortMetric[] = matchingMembers.map((member) => {
    const list = unpaidByMember.get(member.id) ?? [];
    const next = list[0];
    const overdueCount = list.filter(
      (p) =>
        p.status === 'OVERDUE' || isDueCalendarDateBeforeTodayInGymTZ(p.dueDate, tz)
    ).length;

    return {
      memberId: member.id,
      name: member.name,
      nextDueTime: next?.dueDate.getTime() ?? Number.POSITIVE_INFINITY,
      overdueCount,
    };
  });

  metrics.sort((a, b) => {
    if (sortBy === 'overdueCount') {
      const diff = a.overdueCount - b.overdueCount;
      if (diff !== 0) {
        return collator * diff;
      }
      return a.name.localeCompare(b.name);
    }

    if (a.nextDueTime !== b.nextDueTime) {
      return collator * (a.nextDueTime - b.nextDueTime);
    }
    return a.name.localeCompare(b.name);
  });

  const total = metrics.length;
  const pageMetrics = metrics.slice((page - 1) * limit, page * limit);
  const pageMemberIds = pageMetrics.map((m) => m.memberId);

  if (pageMemberIds.length === 0) {
    return { rows: [], total };
  }

  await syncMembersForPaymentSummary(gymId, pageMemberIds);

  const members = await prisma.member.findMany({
    where: { id: { in: pageMemberIds } },
    select: MEMBER_SUMMARY_SELECT,
  });
  const memberById = new Map(members.map((m) => [m.id, m]));
  const orderedMembers = pageMemberIds
    .map((id) => memberById.get(id))
    .filter((m): m is (typeof members)[0] => m != null);

  const rows = await buildSummaryRowsForMembers(gymId, orderedMembers);
  return { rows, total };
}
