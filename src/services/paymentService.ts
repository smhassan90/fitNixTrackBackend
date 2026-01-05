import { prisma } from '../lib/prisma';
import { parseDurationToMonths, addMonths, formatMonth } from '../utils/dateHelpers';
import { parseDate } from '../utils/dateHelpers';
import { NotFoundError } from '../utils/errors';

/**
 * Generate payments for a member based on their package
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

  // Generate the CURRENT month's payment (same month as membership start, same day)
  // If the due date has passed, mark it as OVERDUE
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  
  // Calculate current month payment due date (same month as membership start, same day)
  // Use the membership start date as the due date for the current month
  const currentDueDate = new Date(membershipStart);
  currentDueDate.setUTCHours(0, 0, 0, 0);
  
  // Calculate amount with discount (price - discount, minimum 0)
  const discount = packageData.discount ?? 0;
  const amount = Math.max(0, packageData.price - discount);
  
  // Only create payment if it's before or equal to membership end
  if (currentDueDate <= membershipEnd) {
    const currentMonth = formatMonth(currentDueDate);

    // Check if payment already exists (shouldn't, but just in case)
    const existingPayment = await prisma.payment.findFirst({
      where: {
        memberId,
        gymId,
        month: currentMonth,
      },
    });

    if (!existingPayment) {
      // Determine status: OVERDUE if due date has passed, otherwise PENDING
      // Compare dates: if due date is before today, it's overdue
      const status = currentDueDate < today ? 'OVERDUE' : 'PENDING';

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
    } else {
      // If payment exists, update its status if it's overdue
      if (existingPayment.status === 'PENDING' && currentDueDate < today) {
        await prisma.payment.update({
          where: { id: existingPayment.id },
          data: { status: 'OVERDUE' },
        });
      }
    }
  }

  // Update member's membership end date and monthly payment amount
  await prisma.member.update({
    where: { id: memberId },
    data: { 
      membershipEnd,
      monthlyPaymentAmount: amount, // Save monthly payment amount for income calculation
    },
  });
}

/**
 * Mark payment as paid and generate next payment if applicable
 */
export async function markPaymentAsPaid(
  paymentId: number,
  gymId: number
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
      // Calculate amount with discount (price - discount, minimum 0)
      const packagePrice = payment.member.package?.price || payment.amount;
      const discount = payment.member.package?.discount ?? 0;
      const amount = Math.max(0, packagePrice - discount);
      
      // Check if due date has passed
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const status = nextDueDate < today ? 'OVERDUE' : 'PENDING';

      await prisma.payment.create({
        data: {
          gymId,
          memberId: payment.memberId,
          month: nextMonth,
          amount,
          status,
          dueDate: nextDueDate,
        },
      });
    }
  }
}

/**
 * Check and mark overdue payments
 */
export async function markOverduePayments(gymId: number): Promise<number> {
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

