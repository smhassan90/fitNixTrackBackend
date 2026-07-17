import { prisma } from '../lib/prisma';

/**
 * Next gym-facing member number for a gym (max numeric legacyMemberId + 1).
 * Non-numeric IDs are ignored for sequencing.
 */
export async function allocateNextLegacyMemberId(gymId: number): Promise<string> {
  const existing = await prisma.member.findMany({
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
  select?: Record<string, boolean>
) {
  const key = String(rawId).trim();
  const asInt = parseInt(key, 10);
  const baseSelect = select ?? undefined;

  if (!Number.isNaN(asInt) && String(asInt) === key) {
    const byPk = await prisma.member.findFirst({
      where: { gymId, id: asInt },
      ...(baseSelect ? { select: baseSelect } : {}),
    });
    if (byPk) return byPk;

    const byNumber = await prisma.member.findFirst({
      where: { gymId, legacyMemberId: key },
      ...(baseSelect ? { select: baseSelect } : {}),
    });
    if (byNumber) return byNumber;
  }

  return prisma.member.findFirst({
    where: { gymId, legacyMemberId: key },
    ...(baseSelect ? { select: baseSelect } : {}),
  });
}
