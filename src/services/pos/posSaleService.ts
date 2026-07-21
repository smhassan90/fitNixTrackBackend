import {
  PosDiscountType,
  PosSaleStatus,
  PosStockMovementType,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import {
  assertValidDiscount,
  computeLineAmounts,
  generateReceiptNo,
  roundMoney,
} from './posHelpers';

type SaleItemInput = {
  productId: number;
  quantity: number;
  discountType?: PosDiscountType;
  discountValue?: number;
};

export async function createSale(
  gymId: number,
  soldById: number,
  canManageDiscounts: boolean,
  input: {
    memberId?: number | null;
    notes?: string | null;
    items: SaleItemInput[];
  }
) {
  if (input.items.length === 0) {
    throw new BadRequestError('Sale must contain at least one item');
  }

  const productIds = input.items.map((item) => item.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw new BadRequestError('Duplicate products in one sale must be merged into a single line item');
  }

  if (input.memberId) {
    const member = await prisma.member.findFirst({
      where: { id: input.memberId, gymId },
    });
    if (!member) throw new BadRequestError('Member not found in this gym');
  }

  const products = await prisma.posProduct.findMany({
    where: {
      id: { in: productIds },
      gymId,
      deletedAt: null,
      isActive: true,
    },
    include: {
      subcategory: { include: { category: true } },
    },
  });

  if (products.length !== productIds.length) {
    throw new BadRequestError('One or more products are invalid or inactive');
  }

  const productMap = new Map(products.map((p) => [p.id, p]));
  const lineItems: Array<{
    productId: number;
    productName: string;
    productType: typeof products[0]['productType'];
    categoryId: number;
    categoryName: string;
    subcategoryId: number;
    subcategoryName: string;
    form: typeof products[0]['form'];
    quantity: number;
    unitPrice: number;
    discountType: PosDiscountType;
    discountValue: number;
    lineSubtotal: number;
    lineDiscount: number;
    lineTotal: number;
    trackInventory: boolean;
  }> = [];

  for (const item of input.items) {
    const product = productMap.get(item.productId)!;
    const enabled = await prisma.gymPosSubcategory.findUnique({
      where: {
        gymId_subcategoryId: { gymId, subcategoryId: product.subcategoryId },
      },
    });
    if (!enabled) {
      throw new BadRequestError(`Product "${product.name}" belongs to a subcategory not enabled for this gym`);
    }

    const discountType = item.discountType ?? product.discountType;
    const discountValue = item.discountValue ?? product.discountValue;
    assertValidDiscount(
      discountType,
      discountValue,
      product.price,
      canManageDiscounts,
      product.discountType,
      product.discountValue
    );

    if (product.trackInventory && product.stockQuantity < item.quantity) {
      throw new BadRequestError(
        `Insufficient stock for "${product.name}". Available: ${product.stockQuantity}, requested: ${item.quantity}`
      );
    }

    const amounts = computeLineAmounts(product.price, item.quantity, discountType, discountValue);
    lineItems.push({
      productId: product.id,
      productName: product.name,
      productType: product.productType,
      categoryId: product.subcategory.category.id,
      categoryName: product.subcategory.category.name,
      subcategoryId: product.subcategory.id,
      subcategoryName: product.subcategory.name,
      form: product.form,
      quantity: item.quantity,
      unitPrice: product.price,
      discountType,
      discountValue,
      ...amounts,
      trackInventory: product.trackInventory,
    });
  }

  const subtotal = roundMoney(lineItems.reduce((sum, line) => sum + line.lineSubtotal, 0));
  const discountTotal = roundMoney(lineItems.reduce((sum, line) => sum + line.lineDiscount, 0));
  const total = roundMoney(lineItems.reduce((sum, line) => sum + line.lineTotal, 0));

  return prisma.$transaction(async (tx) => {
    const receiptNo = generateReceiptNo(gymId);
    const sale = await tx.posSale.create({
      data: {
        gymId,
        receiptNo,
        status: PosSaleStatus.COMPLETED,
        subtotal,
        discountTotal,
        total,
        memberId: input.memberId ?? null,
        soldById,
        notes: input.notes ?? null,
      },
    });

    for (const line of lineItems) {
      await tx.posSaleItem.create({
        data: {
          saleId: sale.id,
          productId: line.productId,
          productName: line.productName,
          productType: line.productType,
          categoryId: line.categoryId,
          categoryName: line.categoryName,
          subcategoryId: line.subcategoryId,
          subcategoryName: line.subcategoryName,
          form: line.form,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: line.discountType,
          discountValue: line.discountValue,
          lineSubtotal: line.lineSubtotal,
          lineDiscount: line.lineDiscount,
          lineTotal: line.lineTotal,
        },
      });

      if (line.trackInventory) {
        const product = await tx.posProduct.update({
          where: { id: line.productId },
          data: { stockQuantity: { decrement: line.quantity } },
        });
        await tx.posStockMovement.create({
          data: {
            gymId,
            productId: line.productId,
            type: PosStockMovementType.SALE,
            quantity: -line.quantity,
            stockAfter: product.stockQuantity,
            saleId: sale.id,
            createdById: soldById,
          },
        });
      }
    }

    return getSale(gymId, sale.id);
  });
}

export async function voidSale(
  gymId: number,
  saleId: number,
  voidedById: number,
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    const sale = await tx.posSale.findFirst({
      where: { id: saleId, gymId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundError('Sale', saleId);
    if (sale.status === PosSaleStatus.VOIDED) {
      throw new BadRequestError('Sale is already voided');
    }

    for (const item of sale.items) {
      const product = await tx.posProduct.findUnique({ where: { id: item.productId } });
      if (!product || !product.trackInventory) continue;

      const stockAfter = product.stockQuantity + item.quantity;
      await tx.posProduct.update({
        where: { id: item.productId },
        data: { stockQuantity: stockAfter },
      });
      await tx.posStockMovement.create({
        data: {
          gymId,
          productId: item.productId,
          type: PosStockMovementType.RETURN,
          quantity: item.quantity,
          stockAfter,
          saleId: sale.id,
          note: `Void: ${reason}`,
          createdById: voidedById,
        },
      });
    }

    await tx.posSale.update({
      where: { id: saleId },
      data: {
        status: PosSaleStatus.VOIDED,
        voidedAt: new Date(),
        voidedById,
        voidReason: reason,
      },
    });

    return getSale(gymId, saleId);
  });
}

export async function getSale(gymId: number, saleId: number) {
  const sale = await prisma.posSale.findFirst({
    where: { id: saleId, gymId },
    include: {
      items: { orderBy: { id: 'asc' } },
      member: { select: { id: true, name: true, legacyMemberId: true } },
    },
  });
  if (!sale) throw new NotFoundError('Sale', saleId);
  return sale;
}

export async function listSales(
  gymId: number,
  filters: {
    status?: PosSaleStatus;
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }
) {
  const where = {
    gymId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.from || filters.to
      ? {
          soldAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  const [total, sales] = await Promise.all([
    prisma.posSale.count({ where }),
    prisma.posSale.findMany({
      where,
      orderBy: { soldAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: {
        items: true,
        member: { select: { id: true, name: true, legacyMemberId: true } },
      },
    }),
  ]);

  return { sales, total };
}

export async function getGymPosSummary(
  gymId: number,
  from?: Date,
  to?: Date,
  groupBy: 'day' | 'category' | 'subcategory' | 'product' = 'day'
) {
  const dateFilter = from || to
    ? PrismaDateFilter(from, to)
    : undefined;

  const salesWhere = {
    gymId,
    status: PosSaleStatus.COMPLETED,
    ...(dateFilter ? { soldAt: dateFilter } : {}),
  };

  const [totals, grouped] = await Promise.all([
    prisma.posSale.aggregate({
      where: salesWhere,
      _sum: { total: true, discountTotal: true, subtotal: true },
      _count: { id: true },
    }),
    groupSalesItems(gymId, from, to, groupBy),
  ]);

  return {
    summary: {
      saleCount: totals._count.id,
      subtotal: roundMoney(totals._sum.subtotal ?? 0),
      discountTotal: roundMoney(totals._sum.discountTotal ?? 0),
      total: roundMoney(totals._sum.total ?? 0),
    },
    grouped,
  };
}

function PrismaDateFilter(from?: Date, to?: Date) {
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };
}

async function groupSalesItems(
  gymId: number,
  from?: Date,
  to?: Date,
  groupBy: 'day' | 'category' | 'subcategory' | 'product' = 'day'
) {
  const sales = await prisma.posSale.findMany({
    where: {
      gymId,
      status: PosSaleStatus.COMPLETED,
      ...(from || to ? { soldAt: PrismaDateFilter(from, to) } : {}),
    },
    select: {
      soldAt: true,
      items: {
        select: {
          productId: true,
          productName: true,
          categoryId: true,
          categoryName: true,
          subcategoryId: true,
          subcategoryName: true,
          quantity: true,
          lineTotal: true,
        },
      },
    },
  });

  const bucket = new Map<string, { key: string; label: string; quantity: number; revenue: number }>();

  for (const sale of sales) {
    for (const item of sale.items) {
      let key: string;
      let label: string;
      switch (groupBy) {
        case 'category':
          key = String(item.categoryId);
          label = item.categoryName;
          break;
        case 'subcategory':
          key = String(item.subcategoryId);
          label = item.subcategoryName;
          break;
        case 'product':
          key = String(item.productId);
          label = item.productName;
          break;
        default:
          key = sale.soldAt.toISOString().slice(0, 10);
          label = key;
      }
      const existing = bucket.get(key) ?? { key, label, quantity: 0, revenue: 0 };
      existing.quantity += item.quantity;
      existing.revenue = roundMoney(existing.revenue + item.lineTotal);
      bucket.set(key, existing);
    }
  }

  return [...bucket.values()].sort((a, b) => b.revenue - a.revenue);
}
