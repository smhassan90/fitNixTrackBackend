/**
 * Format date to YYYY-MM-DD string
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Parse YYYY-MM-DD string to Date
 */
export function parseDate(dateString: string): Date {
  return new Date(dateString + 'T00:00:00.000Z');
}

/**
 * Get start of day in UTC
 */
export function getStartOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Get end of day in UTC
 */
export function getEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Add months to a date (UTC calendar month; matches due dates stored as UTC midnight)
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Parse duration string to months (e.g., "1 month" -> 1, "3 months" -> 3)
 */
export function parseDurationToMonths(duration: string): number {
  const match = duration.match(/(\d+)\s*month/i);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

/**
 * Format month as YYYY-MM (UTC; matches payment dueDate / month field)
 */
export function formatMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Day-of-month from membership start used as the billing anchor (UTC). */
export function getBillingAnchorDayUTC(from: Date): number {
  return from.getUTCDate();
}

/**
 * Next installment after prevDue: move one calendar month forward, then use
 * min(anchorDay, lastDayOfThatMonth). E.g. anchor 30 → Jan 30, Feb 28, Mar 30, Apr 30 (2026).
 */
export function nextBillingDueDate(prevDueDate: Date, anchorDay: number): Date {
  const y = prevDueDate.getUTCFullYear();
  const m = prevDueDate.getUTCMonth();
  let nextM = m + 1;
  let nextY = y;
  if (nextM > 11) {
    nextM = 0;
    nextY += 1;
  }
  const lastDay = new Date(Date.UTC(nextY, nextM + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, lastDay);
  return new Date(Date.UTC(nextY, nextM, day));
}

/** First instant of the calendar month after `reference` (UTC). */
export function startOfNextCalendarMonthUTC(reference: Date): Date {
  const y = reference.getUTCFullYear();
  const m = reference.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1));
}

// --- Gym-local calendar (align with frontend: local date strings, no shifting due alone) ---

const gymDateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatterForTimezone(timeZone: string): Intl.DateTimeFormat {
  let fmt = gymDateFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    gymDateFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * IANA zone for billing/overdue/display (e.g. Asia/Karachi). Match the gym wall clock / frontend locale.
 */
export function getGymTimezone(): string {
  const tz = process.env.GYM_TIMEZONE?.trim();
  return tz && tz.length > 0 ? tz : 'UTC';
}

/** YYYY-MM-DD in the gym timezone (lexicographic compare works for ordering). */
export function calendarDateStringInGymTZ(date: Date, timeZone: string = getGymTimezone()): string {
  return dateFormatterForTimezone(timeZone).format(date);
}

/**
 * Start of the last calendar day of the month containing `ref` (in gym TZ), UTC midnight.
 * e.g. April 2026 → 2026-04-30T00:00:00.000Z
 */
export function endOfCalendarMonthInGymTZ(ref: Date, timeZone: string = getGymTimezone()): Date {
  const ym = calendarDateStringInGymTZ(ref, timeZone).slice(0, 7);
  const [y, mo] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0));
  last.setUTCHours(0, 0, 0, 0);
  return last;
}

/** True if due calendar date is strictly before today's calendar date in the gym TZ (unpaid → overdue). */
export function isDueCalendarDateBeforeTodayInGymTZ(
  dueDate: Date,
  timeZone: string = getGymTimezone()
): boolean {
  const dueStr = calendarDateStringInGymTZ(dueDate, timeZone);
  const todayStr = calendarDateStringInGymTZ(new Date(), timeZone);
  return dueStr < todayStr;
}

/** DB status for a new open installment. */
export function initialOpenInstallmentStatus(
  dueDate: Date,
  timeZone: string = getGymTimezone()
): 'OVERDUE' | 'PENDING' {
  return isDueCalendarDateBeforeTodayInGymTZ(dueDate, timeZone) ? 'OVERDUE' : 'PENDING';
}

/**
 * Billing day-of-month for receipt package coverage.
 * Uses reactivation date when the paid month is on/after billing resume (post freeze/inactive).
 */
export function resolveReceiptAnchorDay(
  membershipStart: Date | null | undefined,
  billingResumeFrom: Date | null | undefined,
  paymentMonthKey: string
): number | null {
  if (!membershipStart) {
    return null;
  }

  const joinDay = getBillingAnchorDayUTC(membershipStart);
  if (!billingResumeFrom) {
    return joinDay;
  }

  const resume = new Date(billingResumeFrom);
  resume.setUTCHours(0, 0, 0, 0);
  const join = new Date(membershipStart);
  join.setUTCHours(0, 0, 0, 0);

  if (resume.getTime() <= join.getTime()) {
    return joinDay;
  }

  if (paymentMonthKey >= formatMonth(resume)) {
    return getBillingAnchorDayUTC(resume);
  }

  return joinDay;
}

/** UTC date on `yearMonthKey` (YYYY-MM) using anchor day, clamped to month length. */
export function dateInMonthWithAnchorDay(yearMonthKey: string, anchorDay: number): Date {
  const [y, mo] = yearMonthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const day = Math.min(anchorDay, lastDay);
  return new Date(Date.UTC(y, mo - 1, day));
}

/**
 * Package coverage on a receipt: start = anchor day in the paid month; expiry = same day next month.
 */
export function computeReceiptPackageCoverage(
  paymentMonthKey: string,
  membershipStart: Date | null | undefined,
  billingResumeFrom: Date | null | undefined
): { startDate: string; expiryDate: string } | null {
  const anchorDay = resolveReceiptAnchorDay(membershipStart, billingResumeFrom, paymentMonthKey);
  if (anchorDay === null) {
    return null;
  }

  const startDate = dateInMonthWithAnchorDay(paymentMonthKey, anchorDay);
  const expiryDate = nextBillingDueDate(startDate, anchorDay);

  return {
    startDate: formatDate(startDate),
    expiryDate: formatDate(expiryDate),
  };
}

/**
 * Last scheduled monthly due date for a package: N payments at anchor rhythm starting membershipStart.
 * Inclusive end of the billing schedule (used so the next installment after the last payment is not created).
 */
export function computeMembershipLastDueDate(
  membershipStart: Date,
  paymentCountMonths: number,
  anchorDay: number
): Date {
  let d = new Date(membershipStart);
  d.setUTCHours(0, 0, 0, 0);
  for (let i = 1; i < paymentCountMonths; i++) {
    d = nextBillingDueDate(d, anchorDay);
  }
  return d;
}

/**
 * Unpaid installment UI bucket — same rules as frontend monthlyInstallmentUi:
 * overdue: due calendar date before today (gym TZ); pending: same calendar month as today; else advance.
 */
export function installmentDisplayBucket(
  status: string,
  dueDate: Date,
  timeZone: string = getGymTimezone()
): 'paid' | 'overdue' | 'pending' | 'advance' {
  if (status === 'PAID') {
    return 'paid';
  }
  return unpaidInstallmentDisplayBucket(dueDate, timeZone);
}

/** Open installment bucket (pending / overdue in DB only). */
export function unpaidInstallmentDisplayBucket(
  dueDate: Date,
  timeZone: string = getGymTimezone()
): 'overdue' | 'pending' | 'advance' {
  const dueStr = calendarDateStringInGymTZ(dueDate, timeZone);
  const todayStr = calendarDateStringInGymTZ(new Date(), timeZone);
  if (dueStr < todayStr) {
    return 'overdue';
  }
  const dueYm = dueStr.slice(0, 7);
  const todayYm = todayStr.slice(0, 7);
  if (dueYm === todayYm) {
    return 'pending';
  }
  return 'advance';
}

function parseYmdParts(dateStr: string): { y: number; mo: number; d: number } {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return { y, mo, d };
}

/**
 * UTC instant of the first millisecond that falls on `dateStr` (YYYY-MM-DD) in the gym wall calendar.
 * Used for inclusive date-range filters on `createdAt` / `paidDate`.
 */
export function startOfGymCalendarDayUtc(
  dateStr: string,
  timeZone: string = getGymTimezone()
): Date {
  const { y, mo, d } = parseYmdParts(dateStr);
  if (timeZone === 'UTC') {
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
  }

  let lo = Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - 72 * 3600 * 1000;
  let hi = Date.UTC(y, mo - 1, d, 0, 0, 0, 0) + 72 * 3600 * 1000;
  while (calendarDateStringInGymTZ(new Date(lo), timeZone) >= dateStr) {
    lo -= 24 * 3600 * 1000;
  }
  while (calendarDateStringInGymTZ(new Date(hi), timeZone) < dateStr) {
    hi += 24 * 3600 * 1000;
  }

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const s = calendarDateStringInGymTZ(new Date(mid), timeZone);
    if (s < dateStr) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const at = calendarDateStringInGymTZ(new Date(lo), timeZone);
  if (at !== dateStr) {
    let t = lo - 48 * 3600 * 1000;
    for (let i = 0; i < 5000; i++) {
      if (calendarDateStringInGymTZ(new Date(t), timeZone) === dateStr) {
        return new Date(t);
      }
      t += 60000;
    }
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
  }
  return new Date(lo);
}

/** First instant of the calendar day after `dateStr` in gym TZ (exclusive upper bound for `endDate`). */
export function startOfNextGymCalendarDayUtc(
  dateStr: string,
  timeZone: string = getGymTimezone()
): Date {
  const t0 = startOfGymCalendarDayUtc(dateStr, timeZone).getTime();
  const prev = dateStr;
  for (let h = 1; h <= 48; h++) {
    const t = t0 + h * 3600000;
    const s = calendarDateStringInGymTZ(new Date(t), timeZone);
    if (s !== prev) {
      return startOfGymCalendarDayUtc(s, timeZone);
    }
  }
  for (let m = 1; m <= 2000; m++) {
    const t = t0 + m * 60000;
    const s = calendarDateStringInGymTZ(new Date(t), timeZone);
    if (s !== prev) {
      return startOfGymCalendarDayUtc(s, timeZone);
    }
  }
  const { y, mo, d } = parseYmdParts(dateStr);
  return new Date(Date.UTC(y, mo - 1, d + 1, 0, 0, 0, 0));
}

/**
 * Inclusive gym-local dates from `fromYmd` through `toYmd` as `[YYYY-MM-DD, ...]`.
 */
export function enumerateGymCalendarDaysInclusive(
  fromYmd: string,
  toYmd: string,
  timeZone: string = getGymTimezone()
): string[] {
  if (fromYmd > toYmd) {
    return [];
  }
  const out: string[] = [];
  let cur = fromYmd;
  for (let guard = 0; guard < 800 && cur <= toYmd; guard++) {
    out.push(cur);
    if (cur === toYmd) {
      break;
    }
    const nextStart = startOfNextGymCalendarDayUtc(cur, timeZone);
    cur = calendarDateStringInGymTZ(nextStart, timeZone);
  }
  return out;
}

