import { prisma } from '../lib/prisma';
import type { Prisma } from '@prisma/client';

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Next gym-facing member number for a gym (max numeric legacyMemberId + 1).
 * Non-numeric legacy IDs are ignored for sequencing.
 */
export async function allocateNextLegacyMemberId(gymId: number, db: Db = prisma): Promise<string> {
  const existing = await db.member.findMany({
    where: { gymId, legacyMemberId: { not: null } },
    select: { legacyMemberId: true },
  });

  let max = 0;
  for (const row of existing) {
    const raw = row.legacyMemberId?.trim();
    if (!raw || !/^\d+$/.test(raw)) continue;
    const n = parseInt(raw, 10);
    if (n > max) max = n;
  }

  return String(max + 1);
}

/**
 * Resolve a member by internal PK or gym-facing member number (legacyMemberId).
 */
export async function findMemberByIdOrNumber(
  gymId: number,
  rawId: string | number,
  select?: Record<string, boolean>,
  db: Db = prisma
) {
  const key = String(rawId).trim();
  const asInt = parseInt(key, 10);
  const baseSelect = select ?? undefined;

  if (!Number.isNaN(asInt) && String(asInt) === key) {
    const byPk = await db.member.findFirst({
      where: { gymId, id: asInt },
      ...(baseSelect ? { select: baseSelect } : {}),
    });
    if (byPk) return byPk;

    const byNumber = await db.member.findFirst({
      where: { gymId, legacyMemberId: key },
      ...(baseSelect ? { select: baseSelect } : {}),
    });
    if (byNumber) return byNumber;
  }

  return db.member.findFirst({
    where: { gymId, legacyMemberId: key },
    ...(baseSelect ? { select: baseSelect } : {}),
  });
}

/** Resolve route/query member id to internal PK (accepts legacy member number). */
export async function resolveMemberInternalId(
  gymId: number,
  rawId: string | number,
  db: Db = prisma
): Promise<number | null> {
  const member = await findMemberByIdOrNumber(gymId, rawId, { id: true }, db);
  return member?.id ?? null;
}

export function isLegacyMemberIdUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  if ((error as { code?: string }).code !== 'P2002') return false;
  const target = (error as { meta?: { target?: string | string[] } }).meta?.target;
  if (!target) return true;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((f) => String(f).includes('legacyMemberId'));
}
