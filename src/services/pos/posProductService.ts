import {
  PosDiscountType,
  PosProductForm,
  PosProductType,
  PosStockMovementType,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors';
import {
  assertFormAllowed,
  effectiveAllowedForms,
} from './posHelpers';
import {
  assertGymSubcategoryEnabled,
  getSubcategoryWithCategory,
} from './posCatalogService';

type ProductInput = {
  subcategoryId: number;
  productType: PosProductType;
  form?: PosProductForm;
  name: string;
  sku?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  brand?: string | null;
  price: number;
  discountType?: PosDiscountType;
  discountValue?: number;
  calories?: number | null;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  fiberG?: number | null;
  sugarG?: number | null;
  servingSizeG?: number | null;
  servingLabel?: string | null;
  material?: string | null;
  color?: string | null;
  size?: string | null;
  trackInventory?: boolean;
  lowStockThreshold?: number;
  isActive?: boolean;
  initialStock?: number;
};

function normalizeSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const trimmed = sku.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
}

function validateProductFields(
  productType: PosProductType,
  form: PosProductForm,
  input: ProductInput
): void {
  if (productType === 'NUTRIENT') {
    if (input.calories === null || input.calories === undefined) {
      throw new BadRequestError('Nutrient products require calories');
    }
    if (form === 'PACKAGED') {
      if (input.servingSizeG === null || input.servingSizeG === undefined) {
        throw new BadRequestError('Packaged nutrient products require servingSizeG');
      }
      if (input.proteinG === null || input.proteinG === undefined) {
        throw new BadRequestError('Packaged nutrient products require proteinG');
      }
    }
  } else {
    if (!input.material?.trim()) {
      throw new BadRequestError('Accessory products require material');
    }
  }
}

function validateDiscount(discountType: PosDiscountType, discountValue: number, price: number) {
  if (discountType === 'NONE' && discountValue !== 0) {
    throw new BadRequestError('discountValue must be 0 when discountType is NONE');
  }
  if (discountType === 'PERCENT' && discountValue > 100) {
    throw new BadRequestError('Percent discount cannot exceed 100');
  }
  if (discountType === 'FLAT' && discountValue > price) {
    throw new BadRequestError('Flat discount cannot exceed price');
  }
}

export function serializeProduct(product: {
  id: number;
  gymId: number;
  subcategoryId: number;
  productType: PosProductType;
  form: PosProductForm;
  name: string;
  sku: string | null;
  description: string | null;
  imageUrl: string | null;
  brand: string | null;
  price: number;
  discountType: PosDiscountType;
  discountValue: number;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  servingSizeG: number | null;
  servingLabel: string | null;
  material: string | null;
  color: string | null;
  size: string | null;
  trackInventory: boolean;
  stockQuantity: number;
  lowStockThreshold: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  subcategory?: {
    id: number;
    name: string;
    category: { id: number; name: string; productType: PosProductType };
  };
}) {
  return {
    ...product,
    isLowStock: product.trackInventory && product.stockQuantity <= product.lowStockThreshold,
    subcategory: product.subcategory
      ? {
          id: product.subcategory.id,
          name: product.subcategory.name,
          category: product.subcategory.category,
        }
      : undefined,
  };
}

export async function createGymProduct(gymId: number, userId: number, input: ProductInput) {
  await assertGymSubcategoryEnabled(gymId, input.subcategoryId);
  const sub = await getSubcategoryWithCategory(input.subcategoryId);
  if (sub.category.productType !== input.productType) {
    throw new BadRequestError('productType does not match subcategory');
  }

  const allowed = effectiveAllowedForms(sub.category.productType, sub.allowedForms);
  const form = input.form ?? (allowed.length === 1 ? allowed[0] : 'PACKAGED');
  assertFormAllowed(sub.category.productType, form, sub.allowedForms);
  validateProductFields(sub.category.productType, form, input);

  const discountType = input.discountType ?? 'NONE';
  const discountValue = input.discountValue ?? 0;
  validateDiscount(discountType, discountValue, input.price);

  const sku = normalizeSku(input.sku);
  if (sku) {
    const duplicate = await prisma.posProduct.findFirst({
      where: { gymId, sku, deletedAt: null },
    });
    if (duplicate) throw new ConflictError('SKU already exists for this gym');
  }

  const trackInventory = input.trackInventory ?? (form === 'PACKAGED');
  const initialStock = input.initialStock ?? 0;
  if (initialStock < 0) throw new BadRequestError('initialStock cannot be negative');
  if (!trackInventory && initialStock > 0) {
    throw new BadRequestError('Cannot set initial stock when inventory tracking is disabled');
  }

  return prisma.$transaction(async (tx) => {
    const product = await tx.posProduct.create({
      data: {
        gymId,
        subcategoryId: input.subcategoryId,
        productType: input.productType,
        form,
        name: input.name.trim(),
        sku,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
        brand: input.brand ?? null,
        price: input.price,
        discountType,
        discountValue,
        calories: input.calories ?? null,
        proteinG: input.proteinG ?? null,
        carbsG: input.carbsG ?? null,
        fatG: input.fatG ?? null,
        fiberG: input.fiberG ?? null,
        sugarG: input.sugarG ?? null,
        servingSizeG: input.servingSizeG ?? null,
        servingLabel: input.servingLabel ?? null,
        material: input.material ?? null,
        color: input.color ?? null,
        size: input.size ?? null,
        trackInventory,
        stockQuantity: trackInventory ? initialStock : 0,
        lowStockThreshold: input.lowStockThreshold ?? 5,
        isActive: input.isActive ?? true,
      },
      include: {
        subcategory: { include: { category: true } },
      },
    });

    if (trackInventory && initialStock > 0) {
      await tx.posStockMovement.create({
        data: {
          gymId,
          productId: product.id,
          type: PosStockMovementType.RESTOCK,
          quantity: initialStock,
          stockAfter: initialStock,
          note: 'Initial stock',
          createdById: userId,
        },
      });
    }

    return serializeProduct(product);
  });
}

export async function updateGymProduct(
  gymId: number,
  productId: number,
  input: Partial<ProductInput>
) {
  const existing = await prisma.posProduct.findFirst({
    where: { id: productId, gymId, deletedAt: null },
    include: { subcategory: { include: { category: true } } },
  });
  if (!existing) throw new NotFoundError('Product', productId);

  const nextSubcategoryId = input.subcategoryId ?? existing.subcategoryId;
  if (input.subcategoryId !== undefined) {
    await assertGymSubcategoryEnabled(gymId, nextSubcategoryId);
  }
  const sub = await getSubcategoryWithCategory(nextSubcategoryId);
  const productType = input.productType ?? existing.productType;
  if (sub.category.productType !== productType) {
    throw new BadRequestError('productType does not match subcategory');
  }

  const form = input.form ?? existing.form;
  assertFormAllowed(sub.category.productType, form, sub.allowedForms);

  const merged: ProductInput = {
    subcategoryId: nextSubcategoryId,
    productType,
    form,
    name: input.name ?? existing.name,
    sku: input.sku !== undefined ? input.sku : existing.sku,
    description: input.description !== undefined ? input.description : existing.description,
    imageUrl: input.imageUrl !== undefined ? input.imageUrl : existing.imageUrl,
    brand: input.brand !== undefined ? input.brand : existing.brand,
    price: input.price ?? existing.price,
    discountType: input.discountType ?? existing.discountType,
    discountValue: input.discountValue ?? existing.discountValue,
    calories: input.calories !== undefined ? input.calories : existing.calories,
    proteinG: input.proteinG !== undefined ? input.proteinG : existing.proteinG,
    carbsG: input.carbsG !== undefined ? input.carbsG : existing.carbsG,
    fatG: input.fatG !== undefined ? input.fatG : existing.fatG,
    fiberG: input.fiberG !== undefined ? input.fiberG : existing.fiberG,
    sugarG: input.sugarG !== undefined ? input.sugarG : existing.sugarG,
    servingSizeG: input.servingSizeG !== undefined ? input.servingSizeG : existing.servingSizeG,
    servingLabel: input.servingLabel !== undefined ? input.servingLabel : existing.servingLabel,
    material: input.material !== undefined ? input.material : existing.material,
    color: input.color !== undefined ? input.color : existing.color,
    size: input.size !== undefined ? input.size : existing.size,
    trackInventory: input.trackInventory ?? existing.trackInventory,
    lowStockThreshold: input.lowStockThreshold ?? existing.lowStockThreshold,
  };

  validateProductFields(productType, form, merged);
  validateDiscount(merged.discountType!, merged.discountValue!, merged.price);

  const sku = normalizeSku(merged.sku);
  if (sku) {
    const duplicate = await prisma.posProduct.findFirst({
      where: { gymId, sku, deletedAt: null, id: { not: productId } },
    });
    if (duplicate) throw new ConflictError('SKU already exists for this gym');
  }

  const product = await prisma.posProduct.update({
    where: { id: productId },
    data: {
      subcategoryId: nextSubcategoryId,
      productType,
      form,
      name: merged.name.trim(),
      sku,
      description: merged.description ?? null,
      imageUrl: merged.imageUrl ?? null,
      brand: merged.brand ?? null,
      price: merged.price,
      discountType: merged.discountType,
      discountValue: merged.discountValue,
      calories: merged.calories ?? null,
      proteinG: merged.proteinG ?? null,
      carbsG: merged.carbsG ?? null,
      fatG: merged.fatG ?? null,
      fiberG: merged.fiberG ?? null,
      sugarG: merged.sugarG ?? null,
      servingSizeG: merged.servingSizeG ?? null,
      servingLabel: merged.servingLabel ?? null,
      material: merged.material ?? null,
      color: merged.color ?? null,
      size: merged.size ?? null,
      trackInventory: merged.trackInventory,
      lowStockThreshold: merged.lowStockThreshold,
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: { subcategory: { include: { category: true } } },
  });

  return serializeProduct(product);
}

export async function deactivateGymProduct(gymId: number, productId: number) {
  const existing = await prisma.posProduct.findFirst({
    where: { id: productId, gymId, deletedAt: null },
  });
  if (!existing) throw new NotFoundError('Product', productId);

  const product = await prisma.posProduct.update({
    where: { id: productId },
    data: { isActive: false },
    include: { subcategory: { include: { category: true } } },
  });
  return serializeProduct(product);
}

export async function listGymProducts(gymId: number, filters: {
  productType?: PosProductType;
  subcategoryId?: number;
  isActive?: boolean;
  search?: string;
  page: number;
  limit: number;
}) {
  const where: Prisma.PosProductWhereInput = {
    gymId,
    deletedAt: null,
    ...(filters.productType ? { productType: filters.productType } : {}),
    ...(filters.subcategoryId ? { subcategoryId: filters.subcategoryId } : {}),
    ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    ...(filters.search
      ? {
          OR: [
            { name: { contains: filters.search } },
            { sku: { contains: filters.search.toUpperCase() } },
            { brand: { contains: filters.search } },
          ],
        }
      : {}),
  };

  const [total, products] = await Promise.all([
    prisma.posProduct.count({ where }),
    prisma.posProduct.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: { subcategory: { include: { category: true } } },
    }),
  ]);

  return {
    products: products.map(serializeProduct),
    total,
  };
}

export async function getGymProduct(gymId: number, productId: number) {
  const product = await prisma.posProduct.findFirst({
    where: { id: productId, gymId, deletedAt: null },
    include: { subcategory: { include: { category: true } } },
  });
  if (!product) throw new NotFoundError('Product', productId);
  return serializeProduct(product);
}

export async function restockProduct(
  gymId: number,
  productId: number,
  userId: number,
  quantity: number,
  note?: string | null
) {
  if (quantity <= 0) throw new BadRequestError('quantity must be positive');

  return prisma.$transaction(async (tx) => {
    const product = await tx.posProduct.findFirst({
      where: { id: productId, gymId, deletedAt: null, isActive: true },
    });
    if (!product) throw new NotFoundError('Product', productId);
    if (!product.trackInventory) {
      throw new BadRequestError('Inventory tracking is disabled for this product');
    }

    const stockAfter = product.stockQuantity + quantity;
    await tx.posProduct.update({
      where: { id: productId },
      data: { stockQuantity: stockAfter },
    });
    await tx.posStockMovement.create({
      data: {
        gymId,
        productId,
        type: PosStockMovementType.RESTOCK,
        quantity,
        stockAfter,
        note: note ?? null,
        createdById: userId,
      },
    });

    return getGymProduct(gymId, productId);
  });
}

export async function adjustProductStock(
  gymId: number,
  productId: number,
  userId: number,
  stockQuantity: number,
  note?: string | null
) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.posProduct.findFirst({
      where: { id: productId, gymId, deletedAt: null },
    });
    if (!product) throw new NotFoundError('Product', productId);
    if (!product.trackInventory) {
      throw new BadRequestError('Inventory tracking is disabled for this product');
    }

    const delta = stockQuantity - product.stockQuantity;
    await tx.posProduct.update({
      where: { id: productId },
      data: { stockQuantity },
    });
    await tx.posStockMovement.create({
      data: {
        gymId,
        productId,
        type: PosStockMovementType.ADJUSTMENT,
        quantity: delta,
        stockAfter: stockQuantity,
        note: note ?? null,
        createdById: userId,
      },
    });

    return getGymProduct(gymId, productId);
  });
}

export async function listStockMovements(
  gymId: number,
  productId: number,
  page: number,
  limit: number
) {
  const product = await prisma.posProduct.findFirst({
    where: { id: productId, gymId, deletedAt: null },
  });
  if (!product) throw new NotFoundError('Product', productId);

  const where = { gymId, productId };
  const [total, movements] = await Promise.all([
    prisma.posStockMovement.count({ where }),
    prisma.posStockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { movements, total };
}
