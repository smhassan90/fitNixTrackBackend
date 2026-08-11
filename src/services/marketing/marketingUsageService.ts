import { prisma } from '../../lib/prisma';
import { ValidationError } from '../../utils/errors';

export async function getMarketingUsage(params: {
  gymId: number;
  from: string;
  to: string;
}): Promise<{
  periodStart: string;
  periodEnd: string;
  textRequests: number;
  imageGenerations: number;
  blogGenerations: number;
  estimatedCostUsd: number | null;
  byOperation: Record<string, { count: number; costUsd: number }>;
  rows: Array<{
    id: number;
    operationType: string;
    provider: string | null;
    model: string | null;
    tokens: number | null;
    costUsd: number | null;
    createdAt: string;
  }>;
}> {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError('from and to must be valid ISO datetimes');
  }

  const rows = await prisma.marketingAiUsage.findMany({
    where: {
      gymId: params.gymId,
      createdAt: { gte: from, lte: to },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 500,
  });

  let textRequests = 0;
  let imageGenerations = 0;
  let blogGenerations = 0;
  let costSum = 0;
  let hasCost = false;
  const byOperation: Record<string, { count: number; costUsd: number }> = {};

  for (const row of rows) {
    const op = row.operationType;
    if (!byOperation[op]) byOperation[op] = { count: 0, costUsd: 0 };
    byOperation[op].count += 1;
    if (row.costUsd != null) {
      byOperation[op].costUsd += row.costUsd;
      costSum += row.costUsd;
      hasCost = true;
    }
    if (op === 'IMAGE_GENERATION' || op === 'REGENERATION') imageGenerations += 1;
    else if (op === 'BLOG_GENERATION') blogGenerations += 1;
    else textRequests += 1;
  }

  return {
    periodStart: from.toISOString(),
    periodEnd: to.toISOString(),
    textRequests,
    imageGenerations,
    blogGenerations,
    estimatedCostUsd: hasCost ? Math.round(costSum * 1_000_000) / 1_000_000 : null,
    byOperation,
    rows: rows.map((r) => ({
      id: r.id,
      operationType: r.operationType,
      provider: r.provider,
      model: r.model,
      tokens: r.tokens,
      costUsd: r.costUsd,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function getMarketingAuditLog(params: {
  gymId: number;
  page: number;
  limit: number;
  actionType?: string;
}): Promise<{
  logs: Array<{
    id: number;
    actorUserId: number;
    actorName: string | null;
    actorRole: string;
    actionType: string;
    targetGymId: number | null;
    metadata: unknown;
    createdAt: string;
  }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const where = {
    targetGymId: params.gymId,
    actionType: params.actionType
      ? params.actionType
      : { startsWith: 'MARKETING_' },
  };

  const [total, rows] = await Promise.all([
    prisma.platformAuditLog.count({ where }),
    prisma.platformAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      include: {
        actor: { select: { id: true, name: true } },
      },
    }),
  ]);

  return {
    logs: rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      actorName: r.actor?.name ?? null,
      actorRole: r.actorRole,
      actionType: r.actionType,
      targetGymId: r.targetGymId,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    })),
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / params.limit)),
    },
  };
}
