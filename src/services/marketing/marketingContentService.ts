import {
  MarketingContent,
  MarketingContentStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import { getOrCreateMarketingProfile } from './marketingProfileService';
import { generateSocialPost } from './marketingAiGenerationService';

export const EDITABLE_CONTENT_STATUSES: MarketingContentStatus[] = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'REJECTED',
];

export const CONTENT_EDITABLE_FIELDS = [
  'title',
  'topic',
  'headline',
  'caption',
  'captionShort',
  'cta',
  'hashtags',
  'imageConcept',
  'imagePrompt',
  'suggestedPlatforms',
  'platformVariants',
] as const;

export type ContentEditableField = (typeof CONTENT_EDITABLE_FIELDS)[number];

export type ContentDto = {
  id: number;
  gymId: number;
  opportunityId: number | null;
  contentKind: string;
  title: string;
  status: MarketingContentStatus;
  topic: string | null;
  headline: string | null;
  caption: string | null;
  captionShort: string | null;
  cta: string | null;
  hashtags: string | null;
  imageConcept: string | null;
  imagePrompt: string | null;
  suggestedPlatforms: string[] | null;
  platformVariants: Record<string, string> | null;
  approvedImageVersionId: number | null;
  createdAt: Date;
  updatedAt: Date;
  opportunity?: {
    id: number;
    title: string;
    status: string;
  } | null;
  imageVersions?: Array<{
    id: number;
    contentId: number;
    prompt: string | null;
    modifiedPrompt: string | null;
    imageUrl: string | null;
    status: string;
    provider: string | null;
    createdAt: Date;
  }>;
};

function asPlatforms(value: Prisma.JsonValue | null | undefined): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

function asVariants(
  value: Prisma.JsonValue | null | undefined
): Record<string, string> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function toContentDto(
  row: MarketingContent & {
    opportunity?: { id: number; title: string; status: string } | null;
    imageVersions?: Array<{
      id: number;
      contentId: number;
      prompt: string | null;
      modifiedPrompt: string | null;
      imageUrl: string | null;
      status: string;
      provider: string | null;
      createdAt: Date;
    }>;
  }
): ContentDto {
  return {
    id: row.id,
    gymId: row.gymId,
    opportunityId: row.opportunityId,
    contentKind: row.contentKind,
    title: row.title,
    status: row.status,
    topic: row.topic,
    headline: row.headline,
    caption: row.caption,
    captionShort: row.captionShort,
    cta: row.cta,
    hashtags: row.hashtags,
    imageConcept: row.imageConcept,
    imagePrompt: row.imagePrompt,
    suggestedPlatforms: asPlatforms(row.suggestedPlatforms),
    platformVariants: asVariants(row.platformVariants),
    approvedImageVersionId: row.approvedImageVersionId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    opportunity: row.opportunity
      ? {
          id: row.opportunity.id,
          title: row.opportunity.title,
          status: row.opportunity.status,
        }
      : row.opportunity === null
        ? null
        : undefined,
    imageVersions: row.imageVersions,
  };
}

export async function listContents(params: {
  gymId: number;
  page: number;
  limit: number;
  status?: MarketingContentStatus;
  opportunityId?: number;
}): Promise<{
  contents: ContentDto[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const gym = await prisma.gym.findUnique({ where: { id: params.gymId }, select: { id: true } });
  if (!gym) throw new NotFoundError('Gym', params.gymId);

  const where: Prisma.MarketingContentWhereInput = { gymId: params.gymId };
  if (params.status) where.status = params.status;
  if (params.opportunityId) where.opportunityId = params.opportunityId;

  const [total, rows] = await Promise.all([
    prisma.marketingContent.count({ where }),
    prisma.marketingContent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      include: {
        opportunity: { select: { id: true, title: true, status: true } },
        imageVersions: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
        },
      },
    }),
  ]);

  return {
    contents: rows.map(toContentDto),
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / params.limit)),
    },
  };
}

export async function getContentById(id: number): Promise<ContentDto> {
  const row = await prisma.marketingContent.findUnique({
    where: { id },
    include: {
      opportunity: { select: { id: true, title: true, status: true } },
      imageVersions: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      },
    },
  });
  if (!row) throw new NotFoundError('Content', id);
  return toContentDto(row);
}

/**
 * Generate a social post from an opportunity.
 * Requires opportunity status APPROVED (portal should approve first).
 */
export async function generateSocialPostFromOpportunity(params: {
  opportunityId: number;
  notes?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const opportunity = await prisma.marketingContentOpportunity.findUnique({
    where: { id: params.opportunityId },
  });
  if (!opportunity) throw new NotFoundError('Opportunity', params.opportunityId);

  if (opportunity.status !== 'APPROVED') {
    throw new ValidationError(
      'Opportunity must be APPROVED before generating a social post'
    );
  }

  const gym = await prisma.gym.findUnique({
    where: { id: opportunity.gymId },
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      address: true,
      phone: true,
    },
  });
  if (!gym) throw new NotFoundError('Gym', opportunity.gymId);

  await getOrCreateMarketingProfile(opportunity.gymId);
  const profile = await prisma.marketingProfile.findUniqueOrThrow({
    where: { gymId: opportunity.gymId },
  });

  const { draft, provider, model } = await generateSocialPost(
    {
      gymName: gym.name,
      city: gym.city,
      country: gym.country,
      address: gym.address,
      phone: gym.phone,
      profile,
    },
    {
      id: opportunity.id,
      title: opportunity.title,
      reason: opportunity.reason,
      audience: opportunity.audience,
      contentType: opportunity.contentType,
      suggestedPlatform: opportunity.suggestedPlatform,
      seoIntent: opportunity.seoIntent,
      keywords: opportunity.keywords,
    },
    {
      notes: params.notes,
      platformUserId: params.actorUserId,
    }
  );

  const content = await prisma.$transaction(async (tx) => {
    const created = await tx.marketingContent.create({
      data: {
        gymId: opportunity.gymId,
        opportunityId: opportunity.id,
        contentKind: 'SOCIAL_POST',
        title: draft.title,
        status: 'DRAFT',
        topic: draft.topic,
        headline: draft.headline,
        caption: draft.caption,
        captionShort: draft.captionShort,
        cta: draft.cta,
        hashtags: draft.hashtags,
        imageConcept: draft.imageConcept,
        imagePrompt: draft.imagePrompt,
        suggestedPlatforms: draft.suggestedPlatforms,
        platformVariants: draft.platformVariants,
      },
      include: {
        opportunity: { select: { id: true, title: true, status: true } },
      },
    });

    await tx.marketingContentOpportunity.update({
      where: { id: opportunity.id },
      data: { status: 'CONVERTED' },
    });

    return created;
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_SOCIAL_POST_GENERATE',
    targetGymId: opportunity.gymId,
    metadata: {
      opportunityId: opportunity.id,
      contentId: content.id,
      provider,
      model,
    },
  });

  // Re-fetch so opportunity status reflects CONVERTED
  return getContentById(content.id);
}

export async function updateContent(params: {
  id: number;
  patch: Partial<Record<ContentEditableField, unknown>>;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const existing = await prisma.marketingContent.findUnique({ where: { id: params.id } });
  if (!existing) throw new NotFoundError('Content', params.id);

  if (!EDITABLE_CONTENT_STATUSES.includes(existing.status)) {
    throw new ValidationError(
      `Content in status ${existing.status} cannot be edited`
    );
  }

  const data: Prisma.MarketingContentUpdateInput = {};
  const changedFields: string[] = [];

  for (const key of CONTENT_EDITABLE_FIELDS) {
    if (!(key in params.patch) || params.patch[key] === undefined) continue;
    const next = params.patch[key];
    if (key === 'suggestedPlatforms' || key === 'platformVariants') {
      (data as Record<string, unknown>)[key] =
        next === null ? Prisma.JsonNull : (next as Prisma.InputJsonValue);
    } else {
      const text =
        next === null
          ? null
          : typeof next === 'string'
            ? next.trim() || null
            : String(next);
      (data as Record<string, unknown>)[key] = text;
    }
    changedFields.push(key);
  }

  if (changedFields.length === 0) {
    return getContentById(params.id);
  }

  await prisma.marketingContent.update({
    where: { id: params.id },
    data,
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_UPDATE',
    targetGymId: existing.gymId,
    metadata: { contentId: existing.id, changedFields },
  });

  return getContentById(params.id);
}

export async function submitContentForApproval(params: {
  id: number;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const existing = await prisma.marketingContent.findUnique({ where: { id: params.id } });
  if (!existing) throw new NotFoundError('Content', params.id);
  if (existing.status !== 'DRAFT') {
    throw new ValidationError('Only DRAFT content can be submitted for approval');
  }

  await prisma.marketingContent.update({
    where: { id: params.id },
    data: { status: 'AWAITING_APPROVAL' },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_SUBMIT',
    targetGymId: existing.gymId,
    metadata: { contentId: existing.id },
  });

  return getContentById(params.id);
}

export async function approveContent(params: {
  id: number;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const existing = await prisma.marketingContent.findUnique({ where: { id: params.id } });
  if (!existing) throw new NotFoundError('Content', params.id);
  if (existing.status !== 'DRAFT' && existing.status !== 'AWAITING_APPROVAL') {
    throw new ValidationError('Only DRAFT or AWAITING_APPROVAL content can be approved');
  }

  await prisma.marketingContent.update({
    where: { id: params.id },
    data: { status: 'APPROVED' },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_APPROVE',
    targetGymId: existing.gymId,
    metadata: { contentId: existing.id },
  });

  return getContentById(params.id);
}

export async function rejectContent(params: {
  id: number;
  reason?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const existing = await prisma.marketingContent.findUnique({ where: { id: params.id } });
  if (!existing) throw new NotFoundError('Content', params.id);
  if (existing.status === 'PUBLISHED' || existing.status === 'SCHEDULED') {
    throw new ValidationError('Published or scheduled content cannot be rejected here');
  }

  await prisma.marketingContent.update({
    where: { id: params.id },
    data: { status: 'REJECTED' },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_REJECT',
    targetGymId: existing.gymId,
    metadata: {
      contentId: existing.id,
      reason: params.reason?.trim() || null,
    },
  });

  return getContentById(params.id);
}
