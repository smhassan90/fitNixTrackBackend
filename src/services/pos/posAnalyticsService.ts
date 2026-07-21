import { PosProductType, PosSaleStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { roundMoney } from './posHelpers';

export async function getPlatformPosAnalytics(filters: {
  from?: Date;
  to?: Date;
  gymId?: number;
  productType?: PosProductType;
  categoryId?: number;
  subcategoryId?: number;
  groupBy: 'gym' | 'day' | 'category' | 'subcategory' | 'product';
  limit: number;
}) {
  const saleWhere: Prisma.PosSaleWhereInput = {
    status: PosSaleStatus.COMPLETED,
    ...(filters.gymId ? { gymId: filters.gymId } : {}),
    ...(filters.from || filters.to
      ? {
          soldAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  const itemWhere: Prisma.PosSaleItemWhereInput = {
    sale: saleWhere,
    ...(filters.productType ? { productType: filters.productType } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.subcategoryId ? { subcategoryId: filters.subcategoryId } : {}),
  };

  const [totals, topProducts, grouped] = await Promise.all([
    prisma.posSale.aggregate({
      where: saleWhere,
      _sum: { total: true, discountTotal: true },
      _count: { id: true },
    }),
    prisma.posSaleItem.groupBy({
      by: ['productId', 'productName'],
      where: itemWhere,
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: filters.limit,
    }),
    buildPlatformGrouped(itemWhere, filters.groupBy, filters.limit),
  ]);

  return {
    summary: {
      saleCount: totals._count.id,
      totalRevenue: roundMoney(totals._sum.total ?? 0),
      totalDiscount: roundMoney(totals._sum.discountTotal ?? 0),
    },
    topProducts: topProducts.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      quantitySold: row._sum.quantity ?? 0,
      revenue: roundMoney(row._sum.lineTotal ?? 0),
    })),
    grouped,
  };
}

async function buildPlatformGrouped(
  itemWhere: Prisma.PosSaleItemWhereInput,
  groupBy: 'gym' | 'day' | 'category' | 'subcategory' | 'product',
  limit: number
) {
  if (groupBy === 'gym') {
    const rows = await prisma.posSaleItem.findMany({
      where: itemWhere,
      select: {
        lineTotal: true,
        quantity: true,
        sale: { select: { gymId: true, gym: { select: { id: true, name: true } } } },
      },
    });
    const bucket = new Map<number, { gymId: number; gymName: string; quantity: number; revenue: number }>();
    for (const row of rows) {
      const gymId = row.sale.gymId;
      const existing = bucket.get(gymId) ?? {
        gymId,
        gymName: row.sale.gym.name,
        quantity: 0,
        revenue: 0,
      };
      existing.quantity += row.quantity;
      existing.revenue = roundMoney(existing.revenue + row.lineTotal);
      bucket.set(gymId, existing);
    }
    return [...bucket.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
  }

  if (groupBy === 'day') {
    const sales = await prisma.posSale.findMany({
      where: itemWhere.sale as Prisma.PosSaleWhereInput,
      select: { soldAt: true, total: true },
    });
    const bucket = new Map<string, { day: string; saleCount: number; revenue: number }>();
    for (const sale of sales) {
      const day = sale.soldAt.toISOString().slice(0, 10);
      const existing = bucket.get(day) ?? { day, saleCount: 0, revenue: 0 };
      existing.saleCount += 1;
      existing.revenue = roundMoney(existing.revenue + sale.total);
      bucket.set(day, existing);
    }
    return [...bucket.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(0, limit);
  }

  const groupField =
    groupBy === 'category'
      ? ['categoryId', 'categoryName'] as const
      : groupBy === 'subcategory'
        ? ['subcategoryId', 'subcategoryName'] as const
        : ['productId', 'productName'] as const;

  const rows = await prisma.posSaleItem.groupBy({
    by: [groupField[0], groupField[1]],
    where: itemWhere,
    _sum: { quantity: true, lineTotal: true },
    orderBy: { _sum: { lineTotal: 'desc' } },
    take: limit,
  });

  return rows.map((row) => ({
    id: row[groupField[0] as keyof typeof row],
    name: row[groupField[1] as keyof typeof row],
    quantitySold: row._sum.quantity ?? 0,
    revenue: roundMoney(row._sum.lineTotal ?? 0),
  }));
}

export async function compareGymsByCategory(
  categoryId: number,
  from?: Date,
  to?: Date
) {
  const rows = await prisma.posSaleItem.findMany({
    where: {
      categoryId,
      sale: {
        status: PosSaleStatus.COMPLETED,
        ...(from || to
          ? {
              soldAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
    },
    select: {
      lineTotal: true,
      quantity: true,
      sale: { select: { gymId: true, gym: { select: { name: true } } } },
    },
  });

  const bucket = new Map<number, { gymId: number; gymName: string; quantity: number; revenue: number }>();
  for (const row of rows) {
    const gymId = row.sale.gymId;
    const existing = bucket.get(gymId) ?? {
      gymId,
      gymName: row.sale.gym.name,
      quantity: 0,
      revenue: 0,
    };
    existing.quantity += row.quantity;
    existing.revenue = roundMoney(existing.revenue + row.lineTotal);
    bucket.set(gymId, existing);
  }

  return [...bucket.values()].sort((a, b) => b.revenue - a.revenue);
}
