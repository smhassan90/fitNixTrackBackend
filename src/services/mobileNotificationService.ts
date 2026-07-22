import { MobileAccountType, MobileNotificationType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { markOverduePayments } from './paymentService';

export async function createMobileNotification(input: {
  gymId: number;
  accountType: MobileAccountType;
  memberId?: number;
  trainerId?: number;
  type: MobileNotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.mobileNotification.create({
    data: {
      gymId: input.gymId,
      accountType: input.accountType,
      memberId: input.memberId ?? null,
      trainerId: input.trainerId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function listNotifications(
  actor: {
    gymId: number;
    accountType: MobileAccountType;
    memberId?: number;
    trainerId?: number;
  },
  query: { unreadOnly?: boolean; page?: number; limit?: number }
) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 30, 50);
  const where = {
    gymId: actor.gymId,
    accountType: actor.accountType,
    ...(actor.accountType === 'MEMBER'
      ? { memberId: actor.memberId }
      : { trainerId: actor.trainerId }),
    ...(query.unreadOnly ? { isRead: false } : {}),
  };

  const [total, unreadCount, notifications] = await Promise.all([
    prisma.mobileNotification.count({ where }),
    prisma.mobileNotification.count({ where: { ...where, isRead: false } }),
    prisma.mobileNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { notifications, total, unreadCount, page, limit };
}

export async function markNotificationRead(
  actor: {
    gymId: number;
    accountType: MobileAccountType;
    memberId?: number;
    trainerId?: number;
  },
  notificationId: number
) {
  const notification = await prisma.mobileNotification.findFirst({
    where: {
      id: notificationId,
      gymId: actor.gymId,
      accountType: actor.accountType,
      ...(actor.accountType === 'MEMBER'
        ? { memberId: actor.memberId }
        : { trainerId: actor.trainerId }),
    },
  });
  if (!notification) return null;

  return prisma.mobileNotification.update({
    where: { id: notificationId },
    data: { isRead: true },
  });
}

export async function markAllNotificationsRead(actor: {
  gymId: number;
  accountType: MobileAccountType;
  memberId?: number;
  trainerId?: number;
}) {
  await prisma.mobileNotification.updateMany({
    where: {
      gymId: actor.gymId,
      accountType: actor.accountType,
      isRead: false,
      ...(actor.accountType === 'MEMBER'
        ? { memberId: actor.memberId }
        : { trainerId: actor.trainerId }),
    },
    data: { isRead: true },
  });
}

/** Sync overdue payment alerts for a member (call on app open). */
export async function syncPaymentNotifications(gymId: number, memberId: number) {
  await markOverduePayments(gymId);

  const overdue = await prisma.payment.findMany({
    where: { gymId, memberId, status: 'OVERDUE' },
    orderBy: { dueDate: 'asc' },
    take: 5,
  });

  if (overdue.length === 0) return;

  const existing = await prisma.mobileNotification.findFirst({
    where: {
      gymId,
      memberId,
      type: 'PAYMENT_OVERDUE',
      isRead: false,
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
  });

  if (existing) return;

  const total = overdue.reduce((sum, p) => sum + p.amount, 0);
  await createMobileNotification({
    gymId,
    accountType: 'MEMBER',
    memberId,
    type: 'PAYMENT_OVERDUE',
    title: 'Payment overdue',
    body: `You have ${overdue.length} overdue payment(s) totaling PKR ${total.toLocaleString()}. Please visit the gym counter.`,
    metadata: {
      overdueCount: overdue.length,
      totalAmount: total,
      months: overdue.map((p) => p.month),
    },
  });
}

export async function registerPushToken(
  actor: {
    gymId: number;
    accountType: MobileAccountType;
    memberId?: number;
    trainerId?: number;
  },
  input: { deviceToken: string; platform: 'ios' | 'android' }
) {
  const memberId = actor.accountType === 'MEMBER' ? actor.memberId! : null;
  const trainerId = actor.accountType === 'TRAINER' ? actor.trainerId! : null;

  const existing = await prisma.mobilePushToken.findFirst({
    where: {
      gymId: actor.gymId,
      accountType: actor.accountType,
      memberId,
      trainerId,
      deviceToken: input.deviceToken,
    },
  });

  if (existing) {
    return prisma.mobilePushToken.update({
      where: { id: existing.id },
      data: { platform: input.platform, updatedAt: new Date() },
    });
  }

  return prisma.mobilePushToken.create({
    data: {
      gymId: actor.gymId,
      accountType: actor.accountType,
      memberId,
      trainerId,
      deviceToken: input.deviceToken,
      platform: input.platform,
    },
  });
}
