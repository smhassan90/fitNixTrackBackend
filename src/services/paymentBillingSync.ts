import {
  formatMonth,
  nextBillingDueDate,
  getBillingAnchorDayUTC,
  getGymTimezone,
  calendarDateStringInGymTZ,
  parseDate,
} from '../utils/dateHelpers';

export function shiftToBillableDate(
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
 * Day-of-month used for dues after a reactivation.
 * Pre-operations resumes that land on the 1st keep the original join day.
 * A later resume date (the day they came back) becomes the new billing day.
 */
export function resolveBillingAnchorDay(
  membershipStart: Date | null | undefined,
  billingResumeFrom: Date | null | undefined
): number {
  const start = membershipStart ? new Date(membershipStart) : null;
  if (start) {
    start.setUTCHours(0, 0, 0, 0);
  }
  const fallback = start ? getBillingAnchorDayUTC(start) : 1;
  if (!start || !billingResumeFrom) {
    return fallback;
  }
  const resume = new Date(billingResumeFrom);
  resume.setUTCHours(0, 0, 0, 0);
  if (resume.getTime() <= start.getTime()) {
    return fallback;
  }
  if (resume.getUTCDate() === 1 && isPreOperationsAdmission(start)) {
    return fallback;
  }
  return getBillingAnchorDayUTC(resume);
}

const GAP_DAY_MS = 24 * 60 * 60 * 1000;

/** Days after paid coverage ended and through the inactive date (0 when coverage already reached it). */
export function inactiveGapDays(coverageEnd: Date, inactiveFrom: Date): number {
  const end = new Date(coverageEnd);
  end.setUTCHours(0, 0, 0, 0);
  const inactive = new Date(inactiveFrom);
  inactive.setUTCHours(0, 0, 0, 0);
  return Math.max(0, Math.round((inactive.getTime() - end.getTime()) / GAP_DAY_MS));
}

/**
 * Optional charge for the short active period after the last paid month and before inactiveFrom.
 * Full inactive months are not included. Returns null when there is nothing to bill.
 */
export function buildInactiveGapCharge(params: {
  lastPaidDueDate: Date;
  inactiveFrom: Date;
  joinAnchorDay: number;
  monthlyAmount: number;
}): { dueDate: Date; month: string; amount: number; gapDays: number } | null {
  const lastPaid = new Date(params.lastPaidDueDate);
  lastPaid.setUTCHours(0, 0, 0, 0);
  const coverageEnd = nextBillingDueDate(lastPaid, params.joinAnchorDay);
  const gapDays = inactiveGapDays(coverageEnd, params.inactiveFrom);
  if (gapDays <= 0 || params.monthlyAmount <= 0) {
    return null;
  }
  const amount = Math.round(((params.monthlyAmount * gapDays) / 30) * 100) / 100;
  if (amount <= 0) {
    return null;
  }
  const dueDate = new Date(params.inactiveFrom);
  dueDate.setUTCHours(0, 0, 0, 0);
  return {
    dueDate,
    month: formatMonth(coverageEnd),
    amount,
    gapDays,
  };
}

export function isOptionalGapDue(
  dueDate: Date,
  billingResumeFrom: Date | null | undefined
): boolean {
  if (!billingResumeFrom) {
    return false;
  }
  const due = new Date(dueDate);
  due.setUTCHours(0, 0, 0, 0);
  const resume = new Date(billingResumeFrom);
  resume.setUTCHours(0, 0, 0, 0);
  return due.getTime() < resume.getTime();
}

/**
 * Unpaid rows that are phantom gaps from historical admission seeding — not real debt.
 * Only applies to pre-operations admissions (before GYM_OPERATIONS_START).
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
