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
    deletedAt: Date | null;
    subcategories: Array<{
      id: number;
      categoryId: number;
      name: string;
      code: string | null;
      description: string | null;
      allowedForms: PosProductForm[];
      sortOrder: number;
      isActive: boolean;
      deletedAt: Date | null;
    }>;
  }>;
}>;

export type CreateCategoryResult = {
  category: {
    id: number;
    productType: PosProductType;
    name: string;
    code: string | null;
    description: string | null;
    sortOrder: number;
    isActive: boolean;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  reactivated: boolean;
};

export type CreateSubcategoryResult = {
  subcategory: {
    id: number;
    categoryId: number;
    name: string;
    code: string | null;
    description: string | null;
    allowedForms: Prisma.JsonValue | null;
    sortOrder: number;
    isActive: boolean;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    category: { productType: PosProductType };
  };
  reactivated: boolean;
};

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function categoryConflictDetails(row: {
  id: number;
  name: string;
  code: string | null;
  productType: PosProductType;
  isActive: boolean;
  deletedAt: Date | null;
}, reason: 'name' | 'code') {
  return {
    existingId: row.id,
    name: row.name,
    code: row.code,
    productType: row.productType,
    isActive: row.isActive,
    deletedAt: row.deletedAt,
    conflictOn: reason,
  };
}

function subcategoryConflictDetails(row: {
  id: number;
  name: string;
  code: string | null;
  categoryId: number;
  isActive: boolean;
  deletedAt: Date | null;
}, reason: 'name' | 'code') {
  return {
    existingId: row.id,
    name: row.name,
    code: row.code,
    categoryId: row.categoryId,
    isActive: row.isActive,
    deletedAt: row.deletedAt,
    conflictOn: reason,
  };
}

/** Soft-delete frees global unique `code` so the name can be recreated or reactivated cleanly. */
function freedSoftDeleteCode(code: string | null | undefined, id: number): string | null {
  if (!code) return null;
  const suffix = `__DEL_${id}`;
  const maxLen = 64;
  const base = code.slice(0, Math.max(1, maxLen - suffix.length));
  return `${base}${suffix}`;
}

function serializeSubcategory(row: {
  id: number;
  categoryId: number;
  name: string;
  code: string | null;
  description: string | null;
  allowedForms: Prisma.JsonValue | null;
  sortOrder: number;
  isActive: boolean;
  deletedAt: Date | null;
  category: { productType: PosProductType };
}) {
  return {
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    code: row.code,
    description: row.description,
    allowedForms: effectiveAllowedForms(row.category.productType, row.allowedForms),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    deletedAt: row.deletedAt,
  };
}

export async function listPlatformCatalog(options: {
  productType?: PosProductType;
  includeInactive?: boolean;
}): Promise<PosCatalogTree> {
  // includeInactive=true → inactive AND soft-deleted rows (so CONFLICT leftovers are visible).
  // includeInactive=false → active, non-deleted only.
  const categories = await prisma.posCategory.findMany({
    where: {
      ...(options.productType ? { productType: options.productType } : {}),
      ...(options.includeInactive
        ? {}
        : { deletedAt: null, isActive: true }),
    },
    orderBy: [{ productType: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      subcategories: {
        where: options.includeInactive
          ? {}
          : { deletedAt: null, isActive: true },
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
      deletedAt: category.deletedAt,
      subcategories: category.subcategories.map(serializeSubcategory),
    });
  }

  return [...byType.values()].filter((entry) =>
    options.productType ? entry.productType === options.productType : true
  );
}

async function findCategoryByName(
  productType: PosProductType,
  name: string
) {
  const key = normalizeNameKey(name);
  // MySQL utf8mb4_unicode_ci is case-insensitive; still scan productType rows for trim/case safety.
  const rows = await prisma.posCategory.findMany({
    where: { productType },
    select: {
      id: true,
      name: true,
      code: true,
      productType: true,
      isActive: true,
      deletedAt: true,
      description: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.find((row) => normalizeNameKey(row.name) === key) ?? null;
}

export async function createPlatformCategory(input: {
  productType: PosProductType;
  name: string;
  code?: string | null;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}): Promise<CreateCategoryResult> {
  const name = input.name.trim();
  const code = normalizeOptionalCode(input.code);
  const wantActive = input.isActive ?? true;

  if (code) {
    const byCode = await prisma.posCategory.findFirst({ where: { code } });
    if (byCode) {
      const sameNameAndType =
        byCode.productType === input.productType &&
        normalizeNameKey(byCode.name) === normalizeNameKey(name);
      if (!sameNameAndType) {
        if (byCode.deletedAt === null) {
          throw new ConflictError(
            'Category code already exists',
            categoryConflictDetails(byCode, 'code')
          );
        }
        // Soft-deleted leftover still holding the unique code — free it.
        await prisma.posCategory.update({
          where: { id: byCode.id },
          data: { code: freedSoftDeleteCode(byCode.code, byCode.id) },
        });
      }
    }
  }

  const existing = await findCategoryByName(input.productType, name);

  if (existing) {
    const isReusable = existing.deletedAt !== null || !existing.isActive;
    if (isReusable) {
      // Prefer reactivate over 409 when inactive/soft-deleted match exists.
      let nextCode = code ?? existing.code;
      if (nextCode) {
        const codeOwner = await prisma.posCategory.findFirst({
          where: { code: nextCode, id: { not: existing.id } },
        });
        if (codeOwner) {
          if (codeOwner.deletedAt === null) {
            throw new ConflictError(
              'Category code already exists',
              categoryConflictDetails(codeOwner, 'code')
            );
          }
          await prisma.posCategory.update({
            where: { id: codeOwner.id },
            data: { code: freedSoftDeleteCode(codeOwner.code, codeOwner.id) },
          });
        }
        // Restore original code if soft-delete had suffixed it
        if (!code && existing.code?.includes('__DEL_')) {
          const restored = existing.code.replace(/__DEL_\d+$/, '');
          nextCode = restored || null;
        }
      }

      const category = await prisma.posCategory.update({
        where: { id: existing.id },
        data: {
          name,
          code: nextCode,
          description:
            input.description !== undefined ? input.description : existing.description,
          sortOrder: input.sortOrder !== undefined ? input.sortOrder : existing.sortOrder,
          isActive: wantActive,
          deletedAt: null,
        },
      });
      return { category, reactivated: true };
    }

    throw new ConflictError(
      'Category already exists',
      categoryConflictDetails(existing, 'name')
    );
  }

  if (code) {
    const codeOwner = await prisma.posCategory.findFirst({ where: { code } });
    if (codeOwner) {
      if (codeOwner.deletedAt === null) {
        throw new ConflictError(
          'Category code already exists',
          categoryConflictDetails(codeOwner, 'code')
        );
      }
      await prisma.posCategory.update({
        where: { id: codeOwner.id },
        data: { code: freedSoftDeleteCode(codeOwner.code, codeOwner.id) },
      });
    }
  }

  try {
    const category = await prisma.posCategory.create({
      data: {
        productType: input.productType,
        name,
        code,
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? 0,
        isActive: wantActive,
      },
    });
    return { category, reactivated: false };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const again = await findCategoryByName(input.productType, name);
      if (again) {
        throw new ConflictError(
          'Category already exists',
          categoryConflictDetails(again, 'name')
        );
      }
      throw new ConflictError('Category already exists', {
        conflictOn: 'unique_constraint',
        productType: input.productType,
        name,
        code,
      });
    }
    throw error;
  }
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

  if (name !== undefined) {
    const duplicate = await findCategoryByName(existing.productType, name);
    if (duplicate && duplicate.id !== id && duplicate.deletedAt === null) {
      throw new ConflictError(
        'Category already exists',
        categoryConflictDetails(duplicate, 'name')
      );
    }
  }

  if (code) {
    const byCode = await prisma.posCategory.findFirst({
      where: { code, id: { not: id } },
    });
    if (byCode && byCode.deletedAt === null) {
      throw new ConflictError(
        'Category code already exists',
        categoryConflictDetails(byCode, 'code')
      );
    }
    if (byCode && byCode.deletedAt !== null) {
      await prisma.posCategory.update({
        where: { id: byCode.id },
        data: { code: freedSoftDeleteCode(byCode.code, byCode.id) },
      });
    }
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

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const subs = await tx.posSubcategory.findMany({
      where: { categoryId: id, deletedAt: null },
      select: { id: true, code: true },
    });
    for (const sub of subs) {
      await tx.posSubcategory.update({
        where: { id: sub.id },
        data: {
          deletedAt: now,
          isActive: false,
          code: freedSoftDeleteCode(sub.code, sub.id),
        },
      });
    }
    await tx.posCategory.update({
      where: { id },
      data: {
        deletedAt: now,
        isActive: false,
        code: freedSoftDeleteCode(existing.code, id),
      },
    });
  });
}

async function findSubcategoryByName(categoryId: number, name: string) {
  const key = normalizeNameKey(name);
  const rows = await prisma.posSubcategory.findMany({
    where: { categoryId },
    select: {
      id: true,
      categoryId: true,
      name: true,
      code: true,
      isActive: true,
      deletedAt: true,
      description: true,
      sortOrder: true,
      allowedForms: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.find((row) => normalizeNameKey(row.name) === key) ?? null;
}

export async function createPlatformSubcategory(input: {
  categoryId: number;
  name: string;
  code?: string | null;
  description?: string | null;
  allowedForms?: PosProductForm[] | null;
  sortOrder?: number;
  isActive?: boolean;
}): Promise<CreateSubcategoryResult> {
  const category = await prisma.posCategory.findFirst({
    where: { id: input.categoryId, deletedAt: null },
  });
  if (!category) throw new NotFoundError('Category', input.categoryId);

  const name = input.name.trim();
  const code = normalizeOptionalCode(input.code);
  const wantActive = input.isActive ?? true;
  const allowedForms = resolveSubcategoryAllowedForms(
    category.productType,
    name,
    input.allowedForms
  );

  if (code) {
    const byCode = await prisma.posSubcategory.findFirst({ where: { code } });
    if (byCode) {
      const sameNameAndCategory =
        byCode.categoryId === input.categoryId &&
        normalizeNameKey(byCode.name) === normalizeNameKey(name);
      if (!sameNameAndCategory) {
        if (byCode.deletedAt === null) {
          throw new ConflictError(
            'Subcategory code already exists',
            subcategoryConflictDetails(byCode, 'code')
          );
        }
        await prisma.posSubcategory.update({
          where: { id: byCode.id },
          data: { code: freedSoftDeleteCode(byCode.code, byCode.id) },
        });
      }
    }
  }

  const existing = await findSubcategoryByName(input.categoryId, name);

  if (existing) {
    const isReusable = existing.deletedAt !== null || !existing.isActive;
    if (isReusable) {
      let nextCode = code ?? existing.code;
      if (nextCode) {
        const codeOwner = await prisma.posSubcategory.findFirst({
          where: { code: nextCode, id: { not: existing.id } },
        });
        if (codeOwner?.deletedAt === null) {
          throw new ConflictError(
            'Subcategory code already exists',
            subcategoryConflictDetails(codeOwner, 'code')
          );
        }
        if (codeOwner?.deletedAt) {
          await prisma.posSubcategory.update({
            where: { id: codeOwner.id },
            data: { code: freedSoftDeleteCode(codeOwner.code, codeOwner.id) },
          });
        }
        if (!code && existing.code?.includes('__DEL_')) {
          nextCode = existing.code.replace(/__DEL_\d+$/, '') || null;
        }
      }

      const subcategory = await prisma.posSubcategory.update({
        where: { id: existing.id },
        data: {
          name,
          code: nextCode,
          description:
            input.description !== undefined ? input.description : existing.description,
          allowedForms: allowedForms ?? existing.allowedForms ?? Prisma.JsonNull,
          sortOrder: input.sortOrder !== undefined ? input.sortOrder : existing.sortOrder,
          isActive: wantActive,
          deletedAt: null,
        },
        include: { category: { select: { productType: true } } },
      });
      return { subcategory, reactivated: true };
    }

    throw new ConflictError(
      'Subcategory already exists',
      subcategoryConflictDetails(existing, 'name')
    );
  }

  try {
    const subcategory = await prisma.posSubcategory.create({
      data: {
        categoryId: input.categoryId,
        name,
        code,
        description: input.description ?? null,
        allowedForms: allowedForms ?? Prisma.JsonNull,
        sortOrder: input.sortOrder ?? 0,
        isActive: wantActive,
      },
      include: { category: { select: { productType: true } } },
    });
    return { subcategory, reactivated: false };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const again = await findSubcategoryByName(input.categoryId, name);
      if (again) {
        throw new ConflictError(
          'Subcategory already exists',
          subcategoryConflictDetails(again, 'name')
        );
      }
      throw new ConflictError('Subcategory already exists', {
        conflictOn: 'unique_constraint',
        categoryId: input.categoryId,
        name,
        code,
      });
    }
    throw error;
  }
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

  if (name !== undefined) {
    const duplicate = await findSubcategoryByName(existing.categoryId, name);
    if (duplicate && duplicate.id !== id && duplicate.deletedAt === null) {
      throw new ConflictError(
        'Subcategory already exists',
        subcategoryConflictDetails(duplicate, 'name')
      );
    }
  }

  if (code) {
    const byCode = await prisma.posSubcategory.findFirst({
      where: { code, id: { not: id } },
    });
    if (byCode && byCode.deletedAt === null) {
      throw new ConflictError(
        'Subcategory code already exists',
        subcategoryConflictDetails(byCode, 'code')
      );
    }
    if (byCode && byCode.deletedAt !== null) {
      await prisma.posSubcategory.update({
        where: { id: byCode.id },
        data: { code: freedSoftDeleteCode(byCode.code, byCode.id) },
      });
    }
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
    data: {
      deletedAt: new Date(),
      isActive: false,
      code: freedSoftDeleteCode(existing.code, id),
    },
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
