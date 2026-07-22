import { MobileAccountType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { createSale } from './pos/posSaleService';
import { createMobileNotification } from './mobileNotificationService';

type MobileActor = {
  gymId: number;
  accountType: MobileAccountType;
  memberId?: number;
  trainerId?: number;
};

function generateOrderNo(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MO-${ts}-${rand}`;
}

function serializeOrder(order: {
  id: number;
  orderNo: string;
  status: string;
  placedByType: MobileAccountType;
  memberId: number | null;
  trainerId: number | null;
  subtotal: number;
  total: number;
  notes: string | null;
  posSaleId: number | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    id: number;
    productId: number;
    productName: string;
    productType: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
  }>;
}) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    placedByType: order.placedByType,
    memberId: order.memberId,
    trainerId: order.trainerId,
    subtotal: order.subtotal,
    total: order.total,
    notes: order.notes,
    posSaleId: order.posSaleId,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: order.items,
  };
}

const orderInclude = { items: { orderBy: { id: 'asc' as const } } };

export async function createMobileOrder(
  actor: MobileActor,
  input: {
    items: { productId: number; quantity: number }[];
    notes?: string | null;
    /** Trainer ordering for a member */
    memberId?: number;
  }
) {
  if (input.items.length === 0) {
    throw new BadRequestError('Order must contain at least one item');
  }

  const productIds = input.items.map((i) => i.productId);
  const products = await prisma.posProduct.findMany({
    where: {
      gymId: actor.gymId,
      id: { in: productIds },
      isActive: true,
      deletedAt: null,
    },
    include: {
      subcategory: { include: { category: true } },
    },
  });

  if (products.length !== new Set(productIds).size) {
    throw new BadRequestError('One or more products are unavailable');
  }

  const productMap = new Map(products.map((p) => [p.id, p]));
  let subtotal = 0;
  const lineItems: Array<{
    productId: number;
    productName: string;
    productType: typeof products[0]['productType'];
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
  }> = [];

  for (const item of input.items) {
    const product = productMap.get(item.productId)!;
    if (item.quantity < 1) {
      throw new BadRequestError('Quantity must be at least 1');
    }
    if (product.trackInventory && product.stockQuantity < item.quantity) {
      throw new BadRequestError(`Insufficient stock for ${product.name}`);
    }
    const unitPrice = product.price;
    const lineTotal = unitPrice * item.quantity;
    subtotal += lineTotal;
    lineItems.push({
      productId: product.id,
      productName: product.name,
      productType: product.productType,
      quantity: item.quantity,
      unitPrice,
      lineTotal,
      calories: product.calories,
      proteinG: product.proteinG,
      carbsG: product.carbsG,
      fatG: product.fatG,
    });
  }

  let memberId: number | null = null;
  let trainerId: number | null = null;

  if (actor.accountType === 'MEMBER') {
    memberId = actor.memberId ?? null;
  } else if (input.memberId) {
    const link = await prisma.memberTrainer.findFirst({
      where: {
        trainerId: actor.trainerId!,
        memberId: input.memberId,
        member: { gymId: actor.gymId, isActive: true },
      },
    });
    if (!link) {
      throw new ForbiddenError('Cannot place order for this member');
    }
    memberId = input.memberId;
  } else {
    trainerId = actor.trainerId ?? null;
  }

  const order = await prisma.mobileOrder.create({
    data: {
      gymId: actor.gymId,
      orderNo: generateOrderNo(),
      status: 'PENDING',
      placedByType: actor.accountType,
      memberId,
      trainerId,
      subtotal,
      total: subtotal,
      notes: input.notes?.trim() || null,
      items: { create: lineItems },
    },
    include: orderInclude,
  });

  return serializeOrder(order);
}

export async function listMobileOrders(
  actor: MobileActor,
  query: { status?: string; page?: number; limit?: number; memberId?: number }
) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 20, 50);
  const where: { gymId: number; memberId?: number; trainerId?: number; status?: 'PENDING' | 'COMPLETED' | 'CANCELLED' } = {
    gymId: actor.gymId,
  };

  if (query.status) {
    where.status = query.status.toUpperCase() as 'PENDING' | 'COMPLETED' | 'CANCELLED';
  }

  if (actor.accountType === 'MEMBER') {
    where.memberId = actor.memberId;
  } else if (query.memberId) {
    const link = await prisma.memberTrainer.findFirst({
      where: { trainerId: actor.trainerId!, memberId: query.memberId },
    });
    if (!link) throw new ForbiddenError('Cannot view orders for this member');
    where.memberId = query.memberId;
  } else {
    where.trainerId = actor.trainerId;
  }

  const [total, orders] = await Promise.all([
    prisma.mobileOrder.count({ where }),
    prisma.mobileOrder.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { orders: orders.map(serializeOrder), total, page, limit };
}

export async function getMobileOrder(actor: MobileActor, orderId: number) {
  const order = await prisma.mobileOrder.findFirst({
    where: { id: orderId, gymId: actor.gymId },
    include: orderInclude,
  });
  if (!order) throw new NotFoundError('Order', orderId);

  if (actor.accountType === 'MEMBER' && order.memberId !== actor.memberId) {
    throw new ForbiddenError('Cannot view this order');
  }
  if (
    actor.accountType === 'TRAINER' &&
    order.trainerId !== actor.trainerId &&
    order.memberId
  ) {
    const link = await prisma.memberTrainer.findFirst({
      where: { trainerId: actor.trainerId!, memberId: order.memberId },
    });
    if (!link) throw new ForbiddenError('Cannot view this order');
  }

  return serializeOrder(order);
}

export async function cancelMobileOrder(actor: MobileActor, orderId: number, reason?: string) {
  const order = await prisma.mobileOrder.findFirst({
    where: { id: orderId, gymId: actor.gymId },
  });
  if (!order) throw new NotFoundError('Order', orderId);
  if (order.status !== 'PENDING') {
    throw new BadRequestError('Only pending orders can be cancelled');
  }

  if (actor.accountType === 'MEMBER' && order.memberId !== actor.memberId) {
    throw new ForbiddenError('Cannot cancel this order');
  }
  if (actor.accountType === 'TRAINER' && order.trainerId !== actor.trainerId && order.memberId) {
    throw new ForbiddenError('Cannot cancel this order');
  }

  const updated = await prisma.mobileOrder.update({
    where: { id: orderId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelReason: reason?.trim() || 'Cancelled by user',
    },
    include: orderInclude,
  });
  return serializeOrder(updated);
}

/** Called from gym web portal when staff completes a mobile order at the counter. */
export async function completeMobileOrderFromPortal(
  gymId: number,
  orderId: number,
  soldByUserId: number,
  canManageDiscounts: boolean
) {
  const order = await prisma.mobileOrder.findFirst({
    where: { id: orderId, gymId, status: 'PENDING' },
    include: { items: true },
  });
  if (!order) throw new NotFoundError('Pending mobile order', orderId);

  const sale = await createSale(gymId, soldByUserId, canManageDiscounts, {
    memberId: order.memberId,
    notes: `Mobile order ${order.orderNo}${order.notes ? ` — ${order.notes}` : ''}`,
    items: order.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
  });

  const completed = await prisma.mobileOrder.update({
    where: { id: orderId },
    data: {
      status: 'COMPLETED',
      posSaleId: sale.id,
      completedAt: new Date(),
    },
    include: orderInclude,
  });

  if (order.memberId) {
    await createMobileNotification({
      gymId,
      accountType: 'MEMBER',
      memberId: order.memberId,
      type: 'ORDER_COMPLETED',
      title: 'Order delivered',
      body: `Your order ${order.orderNo} has been completed. Nutrients are now tracked in your analytics.`,
      metadata: { orderId: order.id, orderNo: order.orderNo },
    });
  }
  if (order.trainerId) {
    await createMobileNotification({
      gymId,
      accountType: 'TRAINER',
      trainerId: order.trainerId,
      type: 'ORDER_COMPLETED',
      title: 'Order delivered',
      body: `Your order ${order.orderNo} has been completed.`,
      metadata: { orderId: order.id, orderNo: order.orderNo },
    });
  }

  return { order: serializeOrder(completed), sale };
}

export async function listPendingMobileOrdersForGym(
  gymId: number,
  query: { page?: number; limit?: number }
) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 50, 100);
  const where = { gymId, status: 'PENDING' as const };

  const [total, orders] = await Promise.all([
    prisma.mobileOrder.count({ where }),
    prisma.mobileOrder.findMany({
      where,
      include: {
        items: true,
        member: { select: { id: true, name: true, phone: true, legacyMemberId: true } },
        trainer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { orders, total, page, limit };
}

export async function cancelMobileOrderFromPortal(
  gymId: number,
  orderId: number,
  reason?: string
) {
  const order = await prisma.mobileOrder.findFirst({
    where: { id: orderId, gymId, status: 'PENDING' },
  });
  if (!order) throw new NotFoundError('Pending mobile order', orderId);

  const updated = await prisma.mobileOrder.update({
    where: { id: orderId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelReason: reason?.trim() || 'Cancelled by staff',
    },
    include: orderInclude,
  });
  return serializeOrder(updated);
}
