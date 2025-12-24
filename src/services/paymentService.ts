import { prisma } from '../lib/prisma';
import { parseDurationToMonths, addMonths, formatMonth } from '../utils/dateHelpers';
import { parseDate } from '../utils/dateHelpers';
import { NotFoundError } from '../utils/errors';

/**
 * Generate payments for a member based on their package
 */
export async function generatePaymentsForMember(
  memberId: number,
  gymId: string,
  packageId: string | null,
  membershipStart: Date | null
): Promise<void> {
  if (!packageId || !membershipStart) {
    return;
  }

  // Get package details
  const packageData = await prisma.package.findFirst({
    where: { id: packageId, gymId },
  });

  if (!packageData) {
    return;
  }

  // Calculate duration in months
  const durationMonths = parseDurationToMonths(packageData.duration);
  if (durationMonths === 0) {
    return;
  }

  // Calculate membership end date
  const membershipEnd = addMonths(membershipStart, durationMonths);

  // Delete existing pending payments for this member
  await prisma.payment.deleteMany({
    where: {
      memberId,
      gymId,
      status: 'PENDING',
    },
  });

  // Generate payments for each month
  const payments = [];
  let currentDate = new Date(membershipStart);
  let paymentNumber = 1;

  while (currentDate < membershipEnd) {
    const dueDate = addMonths(membershipStart, paymentNumber);
    const month = formatMonth(currentDate);
    const amount = packageData.price;

    payments.push({
      gymId,
      memberId,
      month,
      amount,
      status: 'PENDING' as const,
      dueDate,
    });

    currentDate = addMonths(currentDate, 1);
    paymentNumber++;
  }

  // Create all payments
  if (payments.length > 0) {
    await prisma.payment.createMany({
      data: payments,
    });
  }

  // Update member's membership end date
  await prisma.member.update({
    where: { id: memberId },
    data: { membershipEnd },
  });
}

/**
 * Mark payment as paid and generate next payment if applicable
 */
export async function markPaymentAsPaid(
  paymentId: string,
  gymId: string
): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, gymId },
    include: { member: { include: { package: true } } },
  });

  if (!payment) {
    throw new NotFoundError('Payment', paymentId);
  }

  // Update payment status
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'PAID',
      paidDate: new Date(),
    },
  });

  // Generate next payment if member has active package
  if (payment.member.packageId && payment.member.membershipEnd) {
    const nextDueDate = addMonths(payment.dueDate, 1);
    const nextMonth = formatMonth(nextDueDate);

    // Check if next payment already exists
    const existingPayment = await prisma.payment.findFirst({
      where: {
        memberId: payment.memberId,
        gymId,
        month: nextMonth,
      },
    });

    if (!existingPayment && nextDueDate <= payment.member.membershipEnd) {
      await prisma.payment.create({
        data: {
          gymId,
          memberId: payment.memberId,
          month: nextMonth,
          amount: payment.member.package?.price || payment.amount,
          status: 'PENDING',
          dueDate: nextDueDate,
        },
      });
    }
  }
}

/**
 * Check and mark overdue payments
 */
export async function markOverduePayments(gymId: string): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const result = await prisma.payment.updateMany({
    where: {
      gymId,
      status: 'PENDING',
      dueDate: {
        lt: today,
      },
    },
    data: {
      status: 'OVERDUE',
    },
  });

  return result.count;
}

