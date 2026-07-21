import {
  PosProductForm,
  PosProductType,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors';
import {
  effectiveAllowedForms,
  normalizeOptionalCode,
  resolveSubcategoryAllowedForms,
} from './posHelpers';

export type PosCatalogTree = Array<{
  productType: PosProductType;
  categories: Array<{
    id: number;
    name: string;
    code: string | null;
    description: string | null;
    sortOrder: number;
    isActive: boolean;
    subcategories: Array<{
      id: number;
      name: string;
      code: string | null;
      description: string | null;
      allowedForms: PosProductForm[];
      sortOrder: number;
      isActive: boolean;
    }>;
  }>;
}>;

function serializeSubcategory(row: {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  allowedForms: Prisma.JsonValue | null;
  sortOrder: number;
  isActive: boolean;
  category: { productType: PosProductType };
}) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    allowedForms: effectiveAllowedForms(row.category.productType, row.allowedForms),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

export async function listPlatformCatalog(options: {
  productType?: PosProductType;
  includeInactive?: boolean;
}): Promise<PosCatalogTree> {
  const categories = await prisma.posCategory.findMany({
    where: {
      deletedAt: null,
      ...(options.productType ? { productType: options.productType } : {}),
      ...(options.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ productType: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      subcategories: {
        where: {
          deletedAt: null,
          ...(options.includeInactive ? {} : { isActive: true }),
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { category: { select: { productType: true } } },
      },
    },
  });

  const byType = new Map<PosProductType, PosCatalogTree[number]>();
  for (const type of ['NUTRIENT', 'ACCESSORY'] as PosProductType[]) {
    byType.set(type, { productType: type, categories: [] });
  }

  for (const category of categories) {
    const entry = byType.get(category.productType)!;
    entry.categories.push({
      id: category.id,
      name: category.name,
      code: category.code,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      subcategories: category.subcategories.map(serializeSubcategory),
    });
  }

  return [...byType.values()].filter((entry) =>
    options.productType ? entry.productType === options.productType : true
  );
}

export async function createPlatformCategory(input: {
  productType: PosProductType;
  name: string;
  code?: string | null;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}) {
  const name = input.name.trim();
  const code = normalizeOptionalCode(input.code);
  const existing = await prisma.posCategory.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { productType: input.productType, name },
        ...(code ? [{ code }] : []),
      ],
    },
  });
  if (existing) throw new ConflictError('Category already exists');

  return prisma.posCategory.create({
    data: {
      productType: input.productType,
      name,
      code,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updatePlatformCategory(
  id: number,
  input: Partial<{
    name: string;
    code: string | null;
    description: string | null;
    sortOrder: number;
    isActive: boolean;
  }>
) {
  const existing = await prisma.posCategory.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new NotFoundError('Category', id);

  const name = input.name !== undefined ? input.name.trim() : undefined;
  const code = input.code !== undefined ? normalizeOptionalCode(input.code) : undefined;
  if (name !== undefined || code !== undefined) {
    const duplicate = await prisma.posCategory.findFirst({
      where: {
        deletedAt: null,
        id: { not: id },
        OR: [
          ...(name !== undefined ? [{ productType: existing.productType, name }] : []),
          ...(code ? [{ code }] : []),
        ],
      },
    });
    if (duplicate) throw new ConflictError('Category already exists');
  }

  return prisma.posCategory.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

export async function deletePlatformCategory(id: number) {
  const existing = await prisma.posCategory.findFirst({
    where: { id, deletedAt: null },
    include: {
      subcategories: {
        where: { deletedAt: null },
        include: { _count: { select: { products: { where: { deletedAt: null, isActive: true } } } } },
      },
    },
  });
  if (!existing) throw new NotFoundError('Category', id);

  const activeProducts = existing.subcategories.some((sub) => sub._count.products > 0);
  if (activeProducts) {
    throw new BadRequestError('Cannot delete category with active gym products. Deactivate it instead.');
  }

  await prisma.$transaction([
    prisma.posSubcategory.updateMany({
      where: { categoryId: id, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false },
    }),
    prisma.posCategory.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    }),
  ]);
}

export async function createPlatformSubcategory(input: {
  categoryId: number;
  name: string;
  code?: string | null;
  description?: string | null;
  allowedForms?: PosProductForm[] | null;
  sortOrder?: number;
  isActive?: boolean;
}) {
  const category = await prisma.posCategory.findFirst({
    where: { id: input.categoryId, deletedAt: null },
  });
  if (!category) throw new NotFoundError('Category', input.categoryId);

  const name = input.name.trim();
  const code = normalizeOptionalCode(input.code);
  const allowedForms = resolveSubcategoryAllowedForms(
    category.productType,
    name,
    input.allowedForms
  );

  const existing = await prisma.posSubcategory.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { categoryId: input.categoryId, name },
        ...(code ? [{ code }] : []),
      ],
    },
  });
  if (existing) throw new ConflictError('Subcategory already exists');

  return prisma.posSubcategory.create({
    data: {
      categoryId: input.categoryId,
      name,
      code,
      description: input.description ?? null,
      allowedForms: allowedForms ?? Prisma.JsonNull,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    },
    include: { category: { select: { productType: true } } },
  });
}

export async function updatePlatformSubcategory(
  id: number,
  input: Partial<{
    name: string;
    code: string | null;
    description: string | null;
    allowedForms: PosProductForm[] | null;
    sortOrder: number;
    isActive: boolean;
  }>
) {
  const existing = await prisma.posSubcategory.findFirst({
    where: { id, deletedAt: null },
    include: { category: true },
  });
  if (!existing) throw new NotFoundError('Subcategory', id);

  const name = input.name !== undefined ? input.name.trim() : undefined;
  const code = input.code !== undefined ? normalizeOptionalCode(input.code) : undefined;
  if (name !== undefined || code !== undefined) {
    const duplicate = await prisma.posSubcategory.findFirst({
      where: {
        deletedAt: null,
        id: { not: id },
        OR: [
          ...(name !== undefined ? [{ categoryId: existing.categoryId, name }] : []),
          ...(code ? [{ code }] : []),
        ],
      },
    });
    if (duplicate) throw new ConflictError('Subcategory already exists');
  }

  let allowedForms: PosProductForm[] | null | undefined;
  const nextName = name ?? existing.name;
  if (input.allowedForms !== undefined || name !== undefined) {
    allowedForms = resolveSubcategoryAllowedForms(
      existing.category.productType,
      nextName,
      input.allowedForms !== undefined ? input.allowedForms : undefined
    );
  }

  return prisma.posSubcategory.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(allowedForms !== undefined
        ? { allowedForms: allowedForms ?? Prisma.JsonNull }
        : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: { category: { select: { productType: true } } },
  });
}

export async function deletePlatformSubcategory(id: number) {
  const existing = await prisma.posSubcategory.findFirst({
    where: { id, deletedAt: null },
    include: { _count: { select: { products: { where: { deletedAt: null, isActive: true } } } } },
  });
  if (!existing) throw new NotFoundError('Subcategory', id);
  if (existing._count.products > 0) {
    throw new BadRequestError('Cannot delete subcategory with active gym products. Deactivate it instead.');
  }

  return prisma.posSubcategory.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
}

export async function getGymCatalog(gymId: number, options: {
  productType?: PosProductType;
  includeDisabled?: boolean;
}) {
  const enabledRows = await prisma.gymPosSubcategory.findMany({
    where: { gymId },
    select: { subcategoryId: true },
  });
  const enabledIds = new Set(enabledRows.map((row) => row.subcategoryId));

  const tree = await listPlatformCatalog({
    productType: options.productType,
    includeInactive: false,
  });

  return tree.map((typeNode) => ({
    ...typeNode,
    categories: typeNode.categories
      .map((category) => ({
        ...category,
        subcategories: category.subcategories
          .map((sub) => ({
            ...sub,
            enabledForGym: enabledIds.has(sub.id),
          }))
          .filter((sub) => options.includeDisabled || sub.enabledForGym),
      }))
      .filter((category) => options.includeDisabled || category.subcategories.length > 0),
  }));
}

export async function setGymEnabledSubcategories(gymId: number, subcategoryIds: number[]) {
  const uniqueIds = [...new Set(subcategoryIds)];
  if (uniqueIds.length > 0) {
    const subs = await prisma.posSubcategory.findMany({
      where: { id: { in: uniqueIds }, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (subs.length !== uniqueIds.length) {
      throw new BadRequestError('One or more subcategories are invalid or inactive');
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.gymPosSubcategory.deleteMany({ where: { gymId } });
    if (uniqueIds.length > 0) {
      await tx.gymPosSubcategory.createMany({
        data: uniqueIds.map((subcategoryId) => ({ gymId, subcategoryId })),
      });
    }
  });

  return getGymCatalog(gymId, { includeDisabled: true });
}

export async function assertGymSubcategoryEnabled(gymId: number, subcategoryId: number) {
  const enabled = await prisma.gymPosSubcategory.findUnique({
    where: { gymId_subcategoryId: { gymId, subcategoryId } },
  });
  if (!enabled) {
    throw new BadRequestError('Subcategory is not enabled for this gym');
  }
}

export async function getSubcategoryWithCategory(subcategoryId: number) {
  const sub = await prisma.posSubcategory.findFirst({
    where: { id: subcategoryId, deletedAt: null, isActive: true },
    include: { category: true },
  });
  if (!sub || !sub.category.isActive || sub.category.deletedAt) {
    throw new NotFoundError('Subcategory', subcategoryId);
  }
  return sub;
}
