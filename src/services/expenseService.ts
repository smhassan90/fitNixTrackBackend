import { ExpenseKind, ExpensePaymentMethod, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import {
  calendarDateStringInGymTZ,
  getGymTimezone,
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
} from '../utils/dateHelpers';

export const DEFAULT_EXPENSE_HEADS: Array<{
  name: string;
  kind: ExpenseKind;
  isRecurring: boolean;
  sortOrder: number;
}> = [
  { name: 'Rent', kind: 'FIXED', isRecurring: true, sortOrder: 10 },
  { name: 'Electricity', kind: 'FIXED', isRecurring: true, sortOrder: 20 },
  { name: 'Internet', kind: 'FIXED', isRecurring: true, sortOrder: 30 },
  { name: 'Salaries', kind: 'FIXED', isRecurring: true, sortOrder: 40 },
  { name: 'Trainer Commission', kind: 'FIXED', isRecurring: true, sortOrder: 50 },
  { name: 'Ice', kind: 'PETTY', isRecurring: false, sortOrder: 60 },
  { name: 'Refreshment', kind: 'PETTY', isRecurring: false, sortOrder: 70 },
  { name: 'Maintenance', kind: 'PETTY', isRecurring: false, sortOrder: 80 },
  { name: 'Equipment', kind: 'PETTY', isRecurring: false, sortOrder: 90 },
  { name: 'Supplies', kind: 'PETTY', isRecurring: false, sortOrder: 100 },
];

const categorySelect = {
  id: true,
  gymId: true,
  name: true,
  kind: true,
  isRecurring: true,
  defaultAmount: true,
  isActive: true,
  sortOrder: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExpenseCategorySelect;

const entryInclude = {
  category: { select: { id: true, name: true, kind: true, isActive: true } },
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.ExpenseEntryInclude;

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

async function findActiveCategoryByName(gymId: number, name: string, excludeId?: number) {
  return prisma.expenseCategory.findFirst({
    where: {
      gymId,
      isActive: true,
      deletedAt: null,
      name,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

export async function ensureDefaultExpenseCategories(gymId: number): Promise<void> {
  const count = await prisma.expenseCategory.count({ where: { gymId } });
  if (count > 0) return;

  await prisma.expenseCategory.createMany({
    data: DEFAULT_EXPENSE_HEADS.map((head) => ({
      gymId,
      name: head.name,
      kind: head.kind,
      isRecurring: head.isRecurring,
      sortOrder: head.sortOrder,
    })),
  });
}

export async function listExpenseCategories(gymId: number, includeInactive = false) {
  await ensureDefaultExpenseCategories(gymId);
  return prisma.expenseCategory.findMany({
    where: includeInactive
      ? { gymId }
      : { gymId, isActive: true, deletedAt: null },
    select: categorySelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function createExpenseCategory(
  gymId: number,
  input: {
    name: string;
    kind?: ExpenseKind;
    isRecurring?: boolean;
    defaultAmount?: number | null;
    sortOrder?: number;
  }
) {
  const name = normalizeName(input.name);
  if (!name) {
    throw new ValidationError('Name is required');
  }

  const inactiveMatch = await prisma.expenseCategory.findFirst({
    where: { gymId, name, OR: [{ isActive: false }, { deletedAt: { not: null } }] },
    orderBy: { id: 'desc' },
  });
  if (inactiveMatch) {
    const conflict = await findActiveCategoryByName(gymId, name, inactiveMatch.id);
    if (conflict) {
      throw new ConflictError(`An active expense head named "${name}" already exists`);
    }
    return prisma.expenseCategory.update({
      where: { id: inactiveMatch.id },
      data: {
        kind: input.kind ?? inactiveMatch.kind,
        isRecurring: input.isRecurring ?? inactiveMatch.isRecurring,
        defaultAmount: input.defaultAmount === undefined ? inactiveMatch.defaultAmount : input.defaultAmount,
        sortOrder: input.sortOrder ?? inactiveMatch.sortOrder,
        isActive: true,
        deletedAt: null,
      },
      select: categorySelect,
    });
  }

  const existing = await findActiveCategoryByName(gymId, name);
  if (existing) {
    throw new ConflictError(`An active expense head named "${name}" already exists`);
  }

  const maxSort = await prisma.expenseCategory.aggregate({
    where: { gymId },
    _max: { sortOrder: true },
  });

  return prisma.expenseCategory.create({
    data: {
      gymId,
      name,
      kind: input.kind ?? 'PETTY',
      isRecurring: input.isRecurring ?? false,
      defaultAmount: input.defaultAmount ?? null,
      sortOrder: input.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 10,
    },
    select: categorySelect,
  });
}

export async function updateExpenseCategory(
  gymId: number,
  id: number,
  input: {
    name?: string;
    kind?: ExpenseKind;
    isRecurring?: boolean;
    defaultAmount?: number | null;
    sortOrder?: number;
    isActive?: boolean;
  }
) {
  const category = await prisma.expenseCategory.findFirst({ where: { id, gymId } });
  if (!category) {
    throw new NotFoundError('Expense head', id);
  }

  const name = input.name !== undefined ? normalizeName(input.name) : undefined;
  if (name !== undefined && !name) {
    throw new ValidationError('Name is required');
  }
  if (name && name !== category.name) {
    const conflict = await findActiveCategoryByName(gymId, name, id);
    if (conflict) {
      throw new ConflictError(`An active expense head named "${name}" already exists`);
    }
  }

  const isActive = input.isActive;
  return prisma.expenseCategory.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.isRecurring !== undefined ? { isRecurring: input.isRecurring } : {}),
      ...(input.defaultAmount !== undefined ? { defaultAmount: input.defaultAmount } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(isActive === false ? { isActive: false, deletedAt: category.deletedAt ?? new Date() } : {}),
      ...(isActive === true ? { isActive: true, deletedAt: null } : {}),
    },
    select: categorySelect,
  });
}

export async function deactivateExpenseCategory(gymId: number, id: number) {
  const category = await prisma.expenseCategory.findFirst({ where: { id, gymId } });
  if (!category) {
    throw new NotFoundError('Expense head', id);
  }
  return prisma.expenseCategory.update({
    where: { id },
    data: { isActive: false, deletedAt: category.deletedAt ?? new Date() },
    select: categorySelect,
  });
}

export function formatExpenseEntry(row: {
  id: number;
  gymId: number;
  categoryId: number;
  amount: number;
  spentAt: Date;
  paymentMethod: ExpensePaymentMethod | null;
  notes: string | null;
  createdById: number;
  updatedById: number | null;
  createdAt: Date;
  updatedAt: Date;
  category: { id: number; name: string; kind: ExpenseKind; isActive: boolean };
  createdBy: { id: number; name: string };
  updatedBy: { id: number; name: string } | null;
}) {
  return {
    id: row.id,
    gymId: row.gymId,
    categoryId: row.categoryId,
    amount: row.amount,
    spentAt: calendarDateStringInGymTZ(row.spentAt),
    paymentMethod: row.paymentMethod,
    notes: row.notes,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    category: row.category,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

export async function listExpenseEntries(
  gymId: number,
  filters: {
    from?: string;
    to?: string;
    categoryId?: number;
    kind?: ExpenseKind;
    page?: number;
    limit?: number;
  }
) {
  const tz = getGymTimezone();
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 50));

  const where: Prisma.ExpenseEntryWhereInput = { gymId };
  if (filters.categoryId) {
    where.categoryId = filters.categoryId;
  }
  if (filters.kind) {
    where.category = { kind: filters.kind };
  }
  if (filters.from || filters.to) {
    where.spentAt = {};
    if (filters.from) {
      where.spentAt.gte = startOfGymCalendarDayUtc(filters.from, tz);
    }
    if (filters.to) {
      where.spentAt.lt = startOfNextGymCalendarDayUtc(filters.to, tz);
    }
  }

  const [rows, total] = await Promise.all([
    prisma.expenseEntry.findMany({
      where,
      include: entryInclude,
      orderBy: [{ spentAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.expenseEntry.count({ where }),
  ]);

  return {
    entries: rows.map(formatExpenseEntry),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

async function requireActiveCategory(gymId: number, categoryId: number) {
  const category = await prisma.expenseCategory.findFirst({
    where: { id: categoryId, gymId },
  });
  if (!category) {
    throw new NotFoundError('Expense head', categoryId);
  }
  if (!category.isActive || category.deletedAt) {
    throw new ValidationError('Cannot post expenses to an inactive head');
  }
  return category;
}

export async function createExpenseEntry(
  gymId: number,
  userId: number,
  input: {
    categoryId: number;
    amount: number;
    spentAt: string;
    paymentMethod?: ExpensePaymentMethod | null;
    notes?: string | null;
  }
) {
  await requireActiveCategory(gymId, input.categoryId);
  const tz = getGymTimezone();
  const spentAt = startOfGymCalendarDayUtc(input.spentAt, tz);

  const row = await prisma.expenseEntry.create({
    data: {
      gymId,
      categoryId: input.categoryId,
      amount: input.amount,
      spentAt,
      paymentMethod: input.paymentMethod ?? null,
      notes: input.notes?.trim() ? input.notes.trim() : null,
      createdById: userId,
    },
    include: entryInclude,
  });
  return formatExpenseEntry(row);
}

export async function updateExpenseEntry(
  gymId: number,
  userId: number,
  id: number,
  input: {
    categoryId?: number;
    amount?: number;
    spentAt?: string;
    paymentMethod?: ExpensePaymentMethod | null;
    notes?: string | null;
  }
) {
  const existing = await prisma.expenseEntry.findFirst({ where: { id, gymId } });
  if (!existing) {
    throw new NotFoundError('Expense entry', id);
  }
  if (input.categoryId !== undefined) {
    await requireActiveCategory(gymId, input.categoryId);
  }

  const tz = getGymTimezone();
  const row = await prisma.expenseEntry.update({
    where: { id },
    data: {
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.spentAt !== undefined ? { spentAt: startOfGymCalendarDayUtc(input.spentAt, tz) } : {}),
      ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() ? input.notes.trim() : null } : {}),
      updatedById: userId,
    },
    include: entryInclude,
  });
  return formatExpenseEntry(row);
}

export async function deleteExpenseEntry(gymId: number, id: number) {
  const existing = await prisma.expenseEntry.findFirst({ where: { id, gymId } });
  if (!existing) {
    throw new NotFoundError('Expense entry', id);
  }
  await prisma.expenseEntry.delete({ where: { id } });
}
