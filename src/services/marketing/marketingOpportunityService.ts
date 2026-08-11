import {
  MarketingContentOpportunity,
  MarketingOpportunityStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import { getOrCreateMarketingProfile } from './marketingProfileService';
import { generateOpportunities } from './marketingAiGenerationService';

export type OpportunityDto = {
  id: number;
  gymId: number;
  title: string;
  reason: string | null;
  audience: string | null;
  contentType: string | null;
  suggestedPlatform: string | null;
  seoIntent: string | null;
  priority: number;
  keywords: string | null;
  status: MarketingOpportunityStatus;
  createdAt: Date;
  updatedAt: Date;
  contentsCount?: number;
};

function toOpportunityDto(
  row: MarketingContentOpportunity & { _count?: { contents: number } }
): OpportunityDto {
  return {
    id: row.id,
    gymId: row.gymId,
    title: row.title,
    reason: row.reason,
    audience: row.audience,
    contentType: row.contentType,
    suggestedPlatform: row.suggestedPlatform,
    seoIntent: row.seoIntent,
    priority: row.priority,
    keywords: row.keywords,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contentsCount: row._count?.contents,
  };
}

export async function listOpportunities(params: {
  gymId: number;
  page: number;
  limit: number;
  status?: MarketingOpportunityStatus;
}): Promise<{
  opportunities: OpportunityDto[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const gym = await prisma.gym.findUnique({ where: { id: params.gymId }, select: { id: true } });
  if (!gym) throw new NotFoundError('Gym', params.gymId);

  const where: Prisma.MarketingContentOpportunityWhereInput = { gymId: params.gymId };
  if (params.status) where.status = params.status;

  const [total, rows] = await Promise.all([
    prisma.marketingContentOpportunity.count({ where }),
    prisma.marketingContentOpportunity.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      include: { _count: { select: { contents: true } } },
    }),
  ]);

  return {
    opportunities: rows.map(toOpportunityDto),
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / params.limit)),
    },
  };
}

export async function getOpportunityById(id: number): Promise<OpportunityDto> {
  const row = await prisma.marketingContentOpportunity.findUnique({
    where: { id },
    include: { _count: { select: { contents: true } } },
  });
  if (!row) throw new NotFoundError('Opportunity', id);
  return toOpportunityDto(row);
}

export async function generateAndStoreOpportunities(params: {
  gymId: number;
  count?: number;
  focus?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<{
  opportunities: OpportunityDto[];
  generatedCount: number;
  provider: string;
  model: string;
}> {
  const gym = await prisma.gym.findUnique({
    where: { id: params.gymId },
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      address: true,
      phone: true,
    },
  });
  if (!gym) throw new NotFoundError('Gym', params.gymId);

  const { dto } = await getOrCreateMarketingProfile(params.gymId);
  const profile = await prisma.marketingProfile.findUniqueOrThrow({
    where: { gymId: params.gymId },
  });

  const existing = await prisma.marketingContentOpportunity.findMany({
    where: { gymId: params.gymId },
    select: { title: true },
    orderBy: { id: 'desc' },
    take: 100,
  });

  const { drafts, provider, model } = await generateOpportunities(
    {
      gymName: gym.name,
      city: gym.city,
      country: gym.country,
      address: gym.address,
      phone: gym.phone,
      profile,
    },
    {
      count: params.count,
      focus: params.focus,
      existingTitles: existing.map((e) => e.title),
      platformUserId: params.actorUserId,
    }
  );

  const created: OpportunityDto[] = [];
  for (const draft of drafts) {
    const row = await prisma.marketingContentOpportunity.create({
      data: {
        gymId: params.gymId,
        title: draft.title,
        reason: draft.reason,
        audience: draft.audience,
        contentType: draft.contentType,
        suggestedPlatform: draft.suggestedPlatform,
        seoIntent: draft.seoIntent,
        priority: draft.priority,
        keywords: draft.keywords,
        status: 'AWAITING_REVIEW',
      },
      include: { _count: { select: { contents: true } } },
    });
    created.push(toOpportunityDto(row));
  }

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_OPPORTUNITIES_GENERATE',
    targetGymId: params.gymId,
    metadata: {
      generatedCount: created.length,
      focus: params.focus ?? null,
      provider,
      model,
      profileId: dto.id,
    },
  });

  return {
    opportunities: created,
    generatedCount: created.length,
    provider,
    model,
  };
}

export async function approveOpportunity(params: {
  id: number;
  actorUserId: number;
  actorRole: string;
}): Promise<OpportunityDto> {
  const row = await prisma.marketingContentOpportunity.findUnique({ where: { id: params.id } });
  if (!row) throw new NotFoundError('Opportunity', params.id);
  if (row.status === 'REJECTED') {
    throw new ValidationError('Rejected opportunities cannot be approved');
  }
  if (row.status === 'CONVERTED') {
    throw new ValidationError('Opportunity is already converted');
  }

  const updated = await prisma.marketingContentOpportunity.update({
    where: { id: params.id },
    data: { status: 'APPROVED' },
    include: { _count: { select: { contents: true } } },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_OPPORTUNITY_APPROVE',
    targetGymId: row.gymId,
    metadata: { opportunityId: row.id },
  });

  return toOpportunityDto(updated);
}

export async function rejectOpportunity(params: {
  id: number;
  reason?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<OpportunityDto> {
  const row = await prisma.marketingContentOpportunity.findUnique({ where: { id: params.id } });
  if (!row) throw new NotFoundError('Opportunity', params.id);
  if (row.status === 'CONVERTED') {
    throw new ValidationError('Converted opportunities cannot be rejected');
  }

  const updated = await prisma.marketingContentOpportunity.update({
    where: { id: params.id },
    data: { status: 'REJECTED' },
    include: { _count: { select: { contents: true } } },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_OPPORTUNITY_REJECT',
    targetGymId: row.gymId,
    metadata: {
      opportunityId: row.id,
      reason: params.reason?.trim() || null,
    },
  });

  return toOpportunityDto(updated);
}
