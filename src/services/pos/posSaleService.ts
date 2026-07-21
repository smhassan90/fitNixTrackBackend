import {
  PosDiscountType,
  PosSaleStatus,
  PosStockMovementType,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import {
  calendarDateStringInGymTZ,
  getGymTimezone,
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
} from '../../utils/dateHelpers';
import { findMemberByIdOrNumber } from '../../utils/memberLookup';
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

type DbClient = Prisma.TransactionClient | typeof prisma;

type SaleWithRelations = {
  id: number;
  gymId: number;
  receiptNo: string;
  status: PosSaleStatus;
  subtotal: number;
  discountTotal: number;
  total: number;
  memberId: number | null;
  soldById: number;
  notes: string | null;
  soldAt: Date;
  voidedAt: Date | null;
  voidedById: number | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<Record<string, unknown>>;
  member: {
    id: number;
    name: string;
    phone: string | null;
    legacyMemberId: string | null;
  } | null;
};

function serializeSale(sale: SaleWithRelations) {
  return {
    id: sale.id,
    gymId: sale.gymId,
    receiptNo: sale.receiptNo,
    status: sale.status,
    memberId: sale.memberId,
    memberName: sale.member?.name ?? null,
    memberPhone: sale.member?.phone ?? null,
    memberNumber: sale.member?.legacyMemberId?.trim() || null,
    subtotal: sale.subtotal,
    discountTotal: sale.discountTotal,
    total: sale.total,
    soldById: sale.soldById,
    notes: sale.notes,
    soldAt: sale.soldAt,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
    voidedAt: sale.voidedAt,
    voidedById: sale.voidedById,
    voidReason: sale.voidReason,
    items: sale.items,
    member: sale.member
      ? {
          id: sale.member.id,
          name: sale.member.name,
          phone: sale.member.phone,
          legacyMemberId: sale.member.legacyMemberId,
        }
      : null,
  };
}

const saleInclude = {
  items: { orderBy: { id: 'asc' as const } },
  member: {
    select: {
      id: true,
      name: true,
      phone: true,
      legacyMemberId: true,
    },
  },
};

async function loadSale(gymId: number, saleId: number, db: DbClient = prisma) {
  const sale = await db.posSale.findFirst({
    where: { id: saleId, gymId },
    include: saleInclude,
  });
  if (!sale) throw new NotFoundError('Sale', saleId);
  return serializeSale(sale as SaleWithRelations);
}

async function resolveSaleMemberId(
  gymId: number,
  rawMemberId: number | string | null | undefined
): Promise<number | null> {
  if (rawMemberId === null || rawMemberId === undefined || rawMemberId === '') {
    return null;
  }
  const member = await findMemberByIdOrNumber(gymId, rawMemberId, {
    id: true,
    name: true,
    phone: true,
    legacyMemberId: true,
  });
  if (!member) {
    throw new BadRequestError('Member not found in this gym');
  }
  return member.id;
}

export async function createSale(
  gymId: number,
  soldById: number,
  canManageDiscounts: boolean,
  input: {
    memberId?: number | string | null;
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

  const memberId = await resolveSaleMemberId(gymId, input.memberId);

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
        memberId,
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

    return loadSale(gymId, sale.id, tx);
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

    return loadSale(gymId, saleId, tx);
  });
}

export async function getSale(gymId: number, saleId: number) {
  return loadSale(gymId, saleId);
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
      include: saleInclude,
    }),
  ]);

  return {
    sales: sales.map((sale) => serializeSale(sale as SaleWithRelations)),
    total,
  };
}

function parseReportDateBound(value: string | undefined, bound: 'from' | 'to'): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return bound === 'from'
      ? startOfGymCalendarDayUtc(trimmed)
      : new Date(startOfNextGymCalendarDayUtc(trimmed).getTime() - 1);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`Invalid ${bound} date`);
  }
  return parsed;
}

function defaultReportRange(): { from: Date; to: Date } {
  const tz = getGymTimezone();
  const todayYmd = calendarDateStringInGymTZ(new Date(), tz);
  const [y, m] = todayYmd.split('-').map(Number);
  const monthStartYmd = `${y}-${String(m).padStart(2, '0')}-01`;
  return {
    from: startOfGymCalendarDayUtc(monthStartYmd, tz),
    to: new Date(startOfNextGymCalendarDayUtc(todayYmd, tz).getTime() - 1),
  };
}

export async function getGymPosSummary(
  gymId: number,
  fromInput?: string,
  toInput?: string,
  groupBy: 'day' | 'category' | 'subcategory' | 'product' = 'day'
) {
  const defaults = defaultReportRange();
  const from = parseReportDateBound(fromInput, 'from') ?? defaults.from;
  const to = parseReportDateBound(toInput, 'to') ?? defaults.to;

  const salesWhere = {
    gymId,
    status: PosSaleStatus.COMPLETED,
    soldAt: { gte: from, lte: to },
  };

  const sales = await prisma.posSale.findMany({
    where: salesWhere,
    select: {
      id: true,
      soldAt: true,
      subtotal: true,
      discountTotal: true,
      total: true,
      items: {
        select: {
          productId: true,
          productName: true,
          categoryId: true,
          categoryName: true,
          subcategoryId: true,
          subcategoryName: true,
          quantity: true,
          lineSubtotal: true,
          lineDiscount: true,
          lineTotal: true,
        },
      },
    },
    orderBy: { soldAt: 'asc' },
  });

  type Row = {
    key: string;
    label: string;
    saleCount: number;
    subtotal: number;
    discountTotal: number;
    total: number;
  };

  const bucket = new Map<string, Row & { saleIds: Set<number> }>();

  const bump = (key: string, label: string, saleId: number, amounts: {
    subtotal: number;
    discountTotal: number;
    total: number;
  }) => {
    const existing = bucket.get(key) ?? {
      key,
      label,
      saleCount: 0,
      subtotal: 0,
      discountTotal: 0,
      total: 0,
      saleIds: new Set<number>(),
    };
    if (!existing.saleIds.has(saleId)) {
      existing.saleIds.add(saleId);
      existing.saleCount += 1;
    }
    existing.subtotal = roundMoney(existing.subtotal + amounts.subtotal);
    existing.discountTotal = roundMoney(existing.discountTotal + amounts.discountTotal);
    existing.total = roundMoney(existing.total + amounts.total);
    bucket.set(key, existing);
  };

  for (const sale of sales) {
    if (groupBy === 'day') {
      const key = calendarDateStringInGymTZ(sale.soldAt);
      bump(key, key, sale.id, {
        subtotal: sale.subtotal,
        discountTotal: sale.discountTotal,
        total: sale.total,
      });
      continue;
    }

    for (const item of sale.items) {
      let key: string;
      let label: string;
      if (groupBy === 'category') {
        key = String(item.categoryId);
        label = item.categoryName;
      } else if (groupBy === 'subcategory') {
        key = String(item.subcategoryId);
        label = item.subcategoryName;
      } else {
        key = String(item.productId);
        label = item.productName;
      }
      bump(key, label, sale.id, {
        subtotal: item.lineSubtotal,
        discountTotal: item.lineDiscount,
        total: item.lineTotal,
      });
    }
  }

  const rows = [...bucket.values()]
    .map(({ saleIds: _saleIds, ...row }) => row)
    .sort((a, b) => {
      if (groupBy === 'day') return a.key.localeCompare(b.key);
      return b.total - a.total;
    });

  const totals = {
    saleCount: sales.length,
    subtotal: roundMoney(sales.reduce((sum, s) => sum + s.subtotal, 0)),
    discountTotal: roundMoney(sales.reduce((sum, s) => sum + s.discountTotal, 0)),
    total: roundMoney(sales.reduce((sum, s) => sum + s.total, 0)),
  };

  return {
    rows,
    totals,
    from: from.toISOString(),
    to: to.toISOString(),
    groupBy,
  };
}
