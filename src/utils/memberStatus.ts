import { calendarDateStringInGymTZ, getGymTimezone, parseDate } from './dateHelpers';

/** Today as YYYY-MM-DD in the gym timezone (for deactivate/reactivate defaults). */
export function todayInGymCalendarDate(): string {
  return calendarDateStringInGymTZ(new Date(), getGymTimezone());
}

/** Parse an optional YYYY-MM-DD body value, or use today in gym TZ. */
export function resolveMemberStatusEffectiveDate(bodyEffectiveDate?: string | null): Date {
  const dateStr = bodyEffectiveDate?.trim() || todayInGymCalendarDate();
  return parseDate(dateStr);
}

/** Format a stored date as YYYY-MM-DD for API / Excel export. */
export function formatMemberCalendarDate(date: Date | null | undefined): string | null {
  if (!date) {
    return null;
  }
  return calendarDateStringInGymTZ(date, getGymTimezone());
}

/**
 * billingResumeFrom is only shown after a real reactivation — not on initial join.
 * When it equals membershipStart (same calendar day), treat as null for the UI.
 */
export function normalizeBillingResumeFromForResponse(
  billingResumeFrom: Date | null | undefined,
  membershipStart: Date | null | undefined
): string | null {
  if (!billingResumeFrom) {
    return null;
  }
  const resumeStr = formatMemberCalendarDate(billingResumeFrom);
  if (!resumeStr) {
    return null;
  }
  if (membershipStart) {
    const startStr = formatMemberCalendarDate(membershipStart);
    if (startStr && resumeStr === startStr) {
      return null;
    }
  }
  return resumeStr;
}

export function formatMemberStatusFields(member: {
  isActive?: boolean | null;
  inactiveFrom?: Date | null;
  billingResumeFrom?: Date | null;
  membershipStart?: Date | null;
}) {
  return {
    isActive: member.isActive ?? true,
    inactiveFrom: formatMemberCalendarDate(member.inactiveFrom),
    billingResumeFrom: normalizeBillingResumeFromForResponse(
      member.billingResumeFrom,
      member.membershipStart
    ),
  };
}
