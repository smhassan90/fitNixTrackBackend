import { prisma } from '../lib/prisma';
import {
  calendarDateStringInGymTZ,
  formatMonth,
  getBillingAnchorDayUTC,
  getGymTimezone,
  getStartOfDay,
  initialOpenInstallmentStatus,
  parseDate,
} from '../utils/dateHelpers';
import {
  resolveBillingResumeFromAfterReturn,
} from '../utils/memberStatus';
import { assertGymCanAddActiveMember } from './planMemberLimitService';
import {
  markOverduePayments,
  syncMissingNextMonthlyInstallment,
  ensureMonthlyInstallmentsThroughMonthKey,
  buildInactiveGapCharge,
  computeMemberMonthlyInstallmentAmount,
} from './paymentService';

export type ReactivateMemberOnReturnResult = {
  reactivated: boolean;
  /** Set when member was already active (no-op). */
  alreadyActive?: boolean;
  /** Human-readable reason reactivation was skipped (e.g. plan member limit). */
  skippedReason?: string;
};

/**
 * Mark an inactive member active again after they return (check-in or manual reactivate).
 * Billing resumes on the return date. Months fully inside the inactive period are not billed.
 * Days after the last paid coverage and before inactiveFrom are one optional prorated charge.
 */
export async function reactivateMemberOnReturn(
  gymId: number,
  memberId: number,
  returnAt: Date
): Promise<ReactivateMemberOnReturnResult> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    select: {
      id: true,
      isActive: true,
      inactiveFrom: true,
      membershipEnd: true,
      membershipStart: true,
      discount: true,
      package: { select: { price: true, discount: true, duration: true } },
      trainers: { include: { trainer: { select: { charges: true } } } },
    },
  });

  if (!member) {
    return { reactivated: false, skippedReason: 'Member not found' };
  }
  if (member.isActive) {
    return { reactivated: false, alreadyActive: true };
  }
  if (!member.inactiveFrom) {
    return {
      reactivated: false,
      skippedReason: 'Inactive start date is missing for this member',
    };
  }

  try {
    await assertGymCanAddActiveMember(gymId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Active member limit reached';
    return { reactivated: false, skippedReason: message };
  }

  const tz = getGymTimezone();
  const returnDay = getStartOfDay(parseDate(calendarDateStringInGymTZ(returnAt, tz)));
  const billingResumeFrom = resolveBillingResumeFromAfterReturn(returnAt);

  if (member.inactiveFrom && returnDay.getTime() < member.inactiveFrom.getTime()) {
    return {
      reactivated: false,
      skippedReason: 'Return date cannot be before inactiveFrom',
    };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const pausedDays = member.inactiveFrom
    ? Math.max(0, Math.floor((returnDay.getTime() - member.inactiveFrom.getTime()) / dayMs))
    : 0;
  const newMembershipEnd =
    member.membershipEnd && pausedDays > 0
      ? new Date(member.membershipEnd.getTime() + pausedDays * dayMs)
      : member.membershipEnd;

  const lastPaid = await prisma.payment.findFirst({
    where: { memberId, gymId, status: 'PAID' },
    orderBy: { dueDate: 'desc' },
  });

  let gapCharge: ReturnType<typeof buildInactiveGapCharge> = null;
  if (lastPaid && member.membershipStart && member.package) {
    const monthlyAmount = computeMemberMonthlyInstallmentAmount(
      member.package,
      member.trainers.map((mt) => mt.trainer),
      member.discount
    );
    gapCharge = buildInactiveGapCharge({
      lastPaidDueDate: lastPaid.dueDate,
      inactiveFrom: member.inactiveFrom,
      joinAnchorDay: getBillingAnchorDayUTC(member.membershipStart),
      monthlyAmount,
    });
    if (gapCharge && formatMonth(billingResumeFrom) === gapCharge.month) {
      gapCharge = null;
    }
  }

  await prisma.member.update({
    where: { id: memberId },
    data: {
      isActive: true,
      inactiveFrom: null,
      billingResumeFrom,
      ...(newMembershipEnd ? { membershipEnd: newMembershipEnd } : {}),
    },
  });

  if (gapCharge) {
    const existingGap = await prisma.payment.findFirst({
      where: { memberId, gymId, month: gapCharge.month },
    });
    if (!existingGap) {
      await prisma.payment.create({
        data: {
          gymId,
          memberId,
          month: gapCharge.month,
          amount: gapCharge.amount,
          status: initialOpenInstallmentStatus(gapCharge.dueDate, tz),
          dueDate: gapCharge.dueDate,
        },
      });
    }
  }

  await syncMissingNextMonthlyInstallment(memberId, gymId);
  const resumeMonthKey = `${billingResumeFrom.getUTCFullYear()}-${String(
    billingResumeFrom.getUTCMonth() + 1
  ).padStart(2, '0')}`;
  await ensureMonthlyInstallmentsThroughMonthKey(memberId, gymId, resumeMonthKey);
  await markOverduePayments(gymId);

  return { reactivated: true };
}
