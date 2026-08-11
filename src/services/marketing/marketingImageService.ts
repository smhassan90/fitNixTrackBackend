import { MarketingImageStatus, MarketingImageVersion } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import { getOrCreateMarketingProfile } from './marketingProfileService';
import {
  callMarketingChatJson,
  callMarketingImageGeneration,
  parseJsonObject,
  recordMarketingAiUsage,
} from './marketingAiClient';
import { storeMarketingImageFile } from './marketingImageStorageService';
import { getContentById, ContentDto } from './marketingContentService';

export type ImageVersionDto = {
  id: number;
  contentId: number;
  prompt: string | null;
  modifiedPrompt: string | null;
  imageUrl: string | null;
  status: MarketingImageStatus;
  provider: string | null;
  createdAt: Date;
};

export function toImageVersionDto(row: MarketingImageVersion): ImageVersionDto {
  return {
    id: row.id,
    contentId: row.contentId,
    prompt: row.prompt,
    modifiedPrompt: row.modifiedPrompt,
    imageUrl: row.imageUrl,
    status: row.status,
    provider: row.provider,
    createdAt: row.createdAt,
  };
}

async function loadContentWithProfile(contentId: number) {
  const content = await prisma.marketingContent.findUnique({
    where: { id: contentId },
  });
  if (!content) throw new NotFoundError('Content', contentId);

  const gym = await prisma.gym.findUnique({
    where: { id: content.gymId },
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      address: true,
      phone: true,
    },
  });
  if (!gym) throw new NotFoundError('Gym', content.gymId);

  await getOrCreateMarketingProfile(content.gymId);
  const profile = await prisma.marketingProfile.findUniqueOrThrow({
    where: { gymId: content.gymId },
  });

  return { content, gym, profile };
}

function asString(v: unknown, max = 4000): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

export async function generateImagePromptForContent(params: {
  contentId: number;
  notes?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const { content, gym, profile } = await loadContentWithProfile(params.contentId);

  const system = `
You write imageConcept + imagePrompt for gym marketing social posts.
HARD RULES:
- Use ONLY facts from the gym marketing profile / gym fields.
- Do NOT invent awards, stats, ratings, facilities, or pricing.
- Prefer realistic fitness photography style unless notes say otherwise.
- Output JSON: { "imageConcept": string, "imagePrompt": string }
`.trim();

  const user = JSON.stringify({
    notes: params.notes?.trim() || null,
    content: {
      title: content.title,
      topic: content.topic,
      headline: content.headline,
      caption: content.caption,
      imageConcept: content.imageConcept,
      imagePrompt: content.imagePrompt,
    },
    gym: {
      gymName: gym.name,
      city: gym.city ?? profile.city,
      country: gym.country ?? profile.country,
      description: profile.description,
      services: profile.services,
      facilities: profile.facilities,
      trainers: profile.trainers,
      brandTone: profile.brandTone,
      targetAudience: profile.targetAudience,
      uniqueSellingPoints: profile.uniqueSellingPoints,
      doNotClaim: profile.doNotClaim,
      additionalInstructions: profile.additionalInstructions,
      preferredLanguage: profile.preferredLanguage,
    },
  });

  const ai = await callMarketingChatJson({ system, user, temperature: 0.55 });
  await recordMarketingAiUsage({
    gymId: content.gymId,
    platformUserId: params.actorUserId,
    operationType: 'IMAGE_PROMPT_GENERATION',
    provider: ai.provider,
    model: ai.model,
    tokens: ai.totalTokens,
    costUsd: ai.costUsd,
  });

  const parsed = parseJsonObject<{ imageConcept?: unknown; imagePrompt?: unknown }>(
    ai.content,
    'image prompt'
  );
  const imageConcept = asString(parsed.imageConcept, 4000);
  const imagePrompt = asString(parsed.imagePrompt, 4000);
  if (!imagePrompt) {
    throw new ValidationError('AI did not return a usable imagePrompt');
  }

  await prisma.marketingContent.update({
    where: { id: content.id },
    data: {
      imageConcept: imageConcept ?? content.imageConcept,
      imagePrompt,
    },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_IMAGE_PROMPT_GENERATE',
    targetGymId: content.gymId,
    metadata: { contentId: content.id, provider: ai.provider, model: ai.model },
  });

  return getContentById(content.id);
}

async function createImageVersionFromPrompt(params: {
  contentId: number;
  gymId: number;
  basePrompt: string;
  effectivePrompt: string;
  actorUserId: number;
  operationType: 'IMAGE_GENERATION' | 'REGENERATION';
}): Promise<ImageVersionDto> {
  const pending = await prisma.marketingImageVersion.create({
    data: {
      contentId: params.contentId,
      prompt: params.basePrompt,
      modifiedPrompt: params.effectivePrompt,
      status: 'PENDING',
      provider: null,
    },
  });

  try {
    const generated = await callMarketingImageGeneration({
      prompt: params.effectivePrompt,
    });

    await recordMarketingAiUsage({
      gymId: params.gymId,
      platformUserId: params.actorUserId,
      operationType: params.operationType,
      provider: generated.provider,
      model: generated.model,
      tokens: null,
      costUsd: generated.costUsd,
    });

    const imageUrl = await storeMarketingImageFile({
      gymId: params.gymId,
      contentId: params.contentId,
      buffer: generated.imageBuffer,
      mimeType: generated.mimeType,
    });

    const ready = await prisma.marketingImageVersion.update({
      where: { id: pending.id },
      data: {
        imageUrl,
        status: 'READY',
        provider: generated.provider,
      },
    });
    return toImageVersionDto(ready);
  } catch (error) {
    await prisma.marketingImageVersion.update({
      where: { id: pending.id },
      data: { status: 'FAILED' },
    });
    throw error;
  }
}

export async function generateImageForContent(params: {
  contentId: number;
  prompt?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<{ content: ContentDto; imageVersion: ImageVersionDto }> {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);

  const bodyPrompt = params.prompt?.trim() || '';
  const effectivePrompt = bodyPrompt || content.imagePrompt?.trim() || '';
  if (!effectivePrompt) {
    throw new ValidationError('imagePrompt is required (provide body.prompt or generate an image prompt first)');
  }

  if (bodyPrompt) {
    await prisma.marketingContent.update({
      where: { id: content.id },
      data: { imagePrompt: bodyPrompt },
    });
  }

  const basePrompt = content.imagePrompt?.trim() || bodyPrompt;
  const imageVersion = await createImageVersionFromPrompt({
    contentId: content.id,
    gymId: content.gymId,
    basePrompt,
    effectivePrompt,
    actorUserId: params.actorUserId,
    operationType: 'IMAGE_GENERATION',
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_IMAGE_GENERATE',
    targetGymId: content.gymId,
    metadata: {
      contentId: content.id,
      imageVersionId: imageVersion.id,
      status: imageVersion.status,
    },
  });

  return {
    content: await getContentById(content.id),
    imageVersion,
  };
}

export async function regenerateImageForContent(params: {
  contentId: number;
  mode: 'quick' | 'custom';
  instructions?: string;
  prompt?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<{ content: ContentDto; imageVersion: ImageVersionDto }> {
  const { content, gym, profile } = await loadContentWithProfile(params.contentId);

  const lastVersion = await prisma.marketingImageVersion.findFirst({
    where: { contentId: content.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  const priorPrompt =
    params.prompt?.trim() ||
    lastVersion?.modifiedPrompt?.trim() ||
    lastVersion?.prompt?.trim() ||
    content.imagePrompt?.trim() ||
    '';

  if (!priorPrompt) {
    throw new ValidationError('No prior image prompt available to regenerate from');
  }

  let effectivePrompt = priorPrompt;

  if (params.mode === 'quick') {
    effectivePrompt = `${priorPrompt}\n\nVariation: slightly different camera angle, lighting, and composition while keeping the same subject and style. Realistic fitness photography.`;
  } else if (params.mode === 'custom') {
    const instructions = params.instructions?.trim();
    if (!instructions) {
      throw new ValidationError('instructions are required for custom regenerate mode');
    }

    const system = `
Rewrite an image generation prompt for a gym marketing post.
HARD RULES:
- Use ONLY profile/gym facts; do not invent awards/stats/facilities.
- Prefer realistic fitness photography unless instructions say otherwise.
- Incorporate the custom instructions.
- Output JSON: { "imagePrompt": string, "imageConcept"?: string }
`.trim();

    const user = JSON.stringify({
      priorPrompt,
      instructions,
      content: {
        title: content.title,
        topic: content.topic,
        caption: content.caption,
      },
      gym: {
        gymName: gym.name,
        city: gym.city ?? profile.city,
        country: gym.country ?? profile.country,
        facilities: profile.facilities,
        services: profile.services,
        brandTone: profile.brandTone,
        doNotClaim: profile.doNotClaim,
      },
    });

    const ai = await callMarketingChatJson({ system, user, temperature: 0.6 });
    await recordMarketingAiUsage({
      gymId: content.gymId,
      platformUserId: params.actorUserId,
      operationType: 'IMAGE_PROMPT_GENERATION',
      provider: ai.provider,
      model: ai.model,
      tokens: ai.totalTokens,
      costUsd: ai.costUsd,
    });

    const parsed = parseJsonObject<{ imagePrompt?: unknown; imageConcept?: unknown }>(
      ai.content,
      'regenerate prompt'
    );
    const rewritten = asString(parsed.imagePrompt, 4000);
    if (!rewritten) {
      throw new ValidationError('AI did not return a usable rewritten imagePrompt');
    }
    effectivePrompt = rewritten;

    const concept = asString(parsed.imageConcept, 4000);
    await prisma.marketingContent.update({
      where: { id: content.id },
      data: {
        imagePrompt: effectivePrompt,
        ...(concept ? { imageConcept: concept } : {}),
      },
    });
  } else {
    throw new ValidationError("mode must be 'quick' or 'custom'");
  }

  if (params.mode === 'quick') {
    await prisma.marketingContent.update({
      where: { id: content.id },
      data: { imagePrompt: effectivePrompt },
    });
  }

  const imageVersion = await createImageVersionFromPrompt({
    contentId: content.id,
    gymId: content.gymId,
    basePrompt: priorPrompt,
    effectivePrompt,
    actorUserId: params.actorUserId,
    operationType: 'REGENERATION',
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_IMAGE_REGENERATE',
    targetGymId: content.gymId,
    metadata: {
      contentId: content.id,
      imageVersionId: imageVersion.id,
      mode: params.mode,
      status: imageVersion.status,
    },
  });

  return {
    content: await getContentById(content.id),
    imageVersion,
  };
}

export async function listImageVersions(contentId: number): Promise<{
  imageVersions: ImageVersionDto[];
}> {
  const content = await prisma.marketingContent.findUnique({
    where: { id: contentId },
    select: { id: true },
  });
  if (!content) throw new NotFoundError('Content', contentId);

  const rows = await prisma.marketingImageVersion.findMany({
    where: { contentId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  return { imageVersions: rows.map(toImageVersionDto) };
}

export async function approveImageVersion(params: {
  contentId: number;
  imageVersionId: number;
  actorUserId: number;
  actorRole: string;
}): Promise<{ content: ContentDto; imageVersion: ImageVersionDto }> {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);

  const version = await prisma.marketingImageVersion.findUnique({
    where: { id: params.imageVersionId },
  });
  if (!version || version.contentId !== content.id) {
    throw new NotFoundError('Image version', params.imageVersionId);
  }
  if (version.status !== 'READY' && version.status !== 'APPROVED') {
    throw new ValidationError('Only READY (or already APPROVED) image versions can be approved');
  }

  await prisma.$transaction(async (tx) => {
    await tx.marketingImageVersion.updateMany({
      where: {
        contentId: content.id,
        status: 'APPROVED',
        id: { not: version.id },
      },
      data: { status: 'REJECTED' },
    });
    await tx.marketingImageVersion.update({
      where: { id: version.id },
      data: { status: 'APPROVED' },
    });
    await tx.marketingContent.update({
      where: { id: content.id },
      data: { approvedImageVersionId: version.id },
    });
  });

  const updated = await prisma.marketingImageVersion.findUniqueOrThrow({
    where: { id: version.id },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_IMAGE_APPROVE',
    targetGymId: content.gymId,
    metadata: {
      contentId: content.id,
      imageVersionId: version.id,
    },
  });

  return {
    content: await getContentById(content.id),
    imageVersion: toImageVersionDto(updated),
  };
}

export async function rejectImageVersion(params: {
  contentId: number;
  imageVersionId: number;
  reason?: string;
  actorUserId: number;
  actorRole: string;
}): Promise<{ content: ContentDto; imageVersion: ImageVersionDto }> {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);

  const version = await prisma.marketingImageVersion.findUnique({
    where: { id: params.imageVersionId },
  });
  if (!version || version.contentId !== content.id) {
    throw new NotFoundError('Image version', params.imageVersionId);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.marketingImageVersion.update({
      where: { id: version.id },
      data: { status: 'REJECTED' },
    });
    if (content.approvedImageVersionId === version.id) {
      await tx.marketingContent.update({
        where: { id: content.id },
        data: { approvedImageVersionId: null },
      });
    }
    return row;
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_IMAGE_REJECT',
    targetGymId: content.gymId,
    metadata: {
      contentId: content.id,
      imageVersionId: version.id,
      reason: params.reason?.trim() || null,
    },
  });

  return {
    content: await getContentById(content.id),
    imageVersion: toImageVersionDto(updated),
  };
}
