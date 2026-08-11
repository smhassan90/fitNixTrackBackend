import { MarketingContent, MarketingPublishAttempt, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import { decryptSecret } from './marketingTokenCrypto';
import { publishViaPlatform } from './socialProviders/publishAdapters';
import { getContentById, ContentDto } from './marketingContentService';

export type PublishAttemptDto = {
  id: number;
  gymId: number;
  contentId: number | null;
  socialAccountId: number | null;
  platform: string | null;
  status: string;
  externalId: string | null;
  errorMessage: string | null;
  attemptedAt: Date;
  createdAt: Date;
};

function toAttemptDto(row: MarketingPublishAttempt): PublishAttemptDto {
  return {
    id: row.id,
    gymId: row.gymId,
    contentId: row.contentId,
    socialAccountId: row.socialAccountId,
    platform: row.platform,
    status: row.status,
    externalId: row.externalId,
    errorMessage: row.errorMessage,
    attemptedAt: row.attemptedAt,
    createdAt: row.createdAt,
  };
}

function parseAccountIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('socialAccountIds is required and must be a non-empty array');
  }
  const ids = raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) {
    throw new ValidationError('socialAccountIds is required and must be a non-empty array');
  }
  return [...new Set(ids)];
}

function captionForPlatform(
  content: MarketingContent,
  platform: string
): string {
  const variants =
    content.platformVariants &&
    typeof content.platformVariants === 'object' &&
    !Array.isArray(content.platformVariants)
      ? (content.platformVariants as Record<string, unknown>)
      : {};
  const key =
    platform === 'google_business'
      ? 'googleBusiness'
      : platform;
  const fromVariant = typeof variants[key] === 'string' ? String(variants[key]).trim() : '';
  if (fromVariant) return fromVariant;
  const base = content.caption?.trim() || content.captionShort?.trim() || content.title;
  const tags = content.hashtags?.trim();
  return tags ? `${base}\n\n${tags}` : base;
}

async function loadApprovedImageUrl(content: MarketingContent): Promise<string | null> {
  if (!content.approvedImageVersionId) return null;
  const img = await prisma.marketingImageVersion.findFirst({
    where: {
      id: content.approvedImageVersionId,
      contentId: content.id,
      status: 'APPROVED',
    },
  });
  return img?.imageUrl ?? null;
}

async function publishToAccounts(params: {
  content: MarketingContent;
  socialAccountIds: number[];
  actorUserId: number;
  actorRole: string;
}): Promise<{
  content: ContentDto;
  attempts: PublishAttemptDto[];
  allSucceeded: boolean;
}> {
  const { content } = params;
  if (content.status !== 'APPROVED' && content.status !== 'FAILED' && content.status !== 'SCHEDULED') {
    throw new ValidationError('Content must be APPROVED (or FAILED/SCHEDULED for retry) before publishing');
  }
  if (!content.approvedImageVersionId) {
    throw new ValidationError('Content requires an approved image version before publishing');
  }

  const accounts = await prisma.marketingSocialAccount.findMany({
    where: {
      id: { in: params.socialAccountIds },
      gymId: content.gymId,
      status: 'CONNECTED',
    },
  });
  if (accounts.length !== params.socialAccountIds.length) {
    throw new ValidationError(
      'One or more social accounts are missing, disconnected, or not in this gym'
    );
  }

  const imageUrl = await loadApprovedImageUrl(content);
  const attempts: PublishAttemptDto[] = [];
  let successCount = 0;

  for (const account of accounts) {
    if (!account.accessTokenEnc || !account.externalAccountId) {
      const failed = await prisma.marketingPublishAttempt.create({
        data: {
          gymId: content.gymId,
          contentId: content.id,
          socialAccountId: account.id,
          platform: account.platform,
          status: 'FAILED',
          errorMessage: 'Social account is missing token or external id',
        },
      });
      attempts.push(toAttemptDto(failed));
      continue;
    }

    const pending = await prisma.marketingPublishAttempt.create({
      data: {
        gymId: content.gymId,
        contentId: content.id,
        socialAccountId: account.id,
        platform: account.platform,
        status: 'PENDING',
      },
    });

    try {
      const accessToken = decryptSecret(account.accessTokenEnc);
      const caption = captionForPlatform(content, account.platform);
      const result = await publishViaPlatform(account.platform, {
        caption,
        imageUrl,
        externalAccountId: account.externalAccountId,
        accessToken,
        metadata: (account.metadata as Record<string, unknown> | null) ?? null,
      });

      const ok = await prisma.marketingPublishAttempt.update({
        where: { id: pending.id },
        data: {
          status: 'SUCCEEDED',
          externalId: result.externalId,
          errorMessage: null,
          attemptedAt: new Date(),
        },
      });
      await prisma.marketingSocialAccount.update({
        where: { id: account.id },
        data: { lastPublishAt: new Date() },
      });
      attempts.push(toAttemptDto(ok));
      successCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Publish failed';
      const failed = await prisma.marketingPublishAttempt.update({
        where: { id: pending.id },
        data: {
          status: 'FAILED',
          errorMessage: message.slice(0, 2000),
          attemptedAt: new Date(),
        },
      });
      attempts.push(toAttemptDto(failed));
    }
  }

  const allSucceeded = successCount === accounts.length && successCount > 0;
  const anySucceeded = successCount > 0;
  await prisma.marketingContent.update({
    where: { id: content.id },
    data: {
      status: anySucceeded ? 'PUBLISHED' : 'FAILED',
      publishedAt: anySucceeded ? new Date() : content.publishedAt,
      scheduledAt: null,
      selectedSocialAccountIds: params.socialAccountIds as unknown as Prisma.InputJsonValue,
    },
  });

  if (params.actorUserId > 0) {
    await writePlatformAuditLog({
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      actionType: 'MARKETING_CONTENT_PUBLISH',
      targetGymId: content.gymId,
      metadata: {
        contentId: content.id,
        socialAccountIds: params.socialAccountIds,
        successCount,
        failCount: accounts.length - successCount,
      },
    });
  }
  return {
    content: await getContentById(content.id),
    attempts,
    allSucceeded,
  };
}

export async function publishContentNow(params: {
  contentId: number;
  socialAccountIds: number[];
  actorUserId: number;
  actorRole: string;
}) {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);
  const ids = parseAccountIds(params.socialAccountIds);
  return publishToAccounts({
    content,
    socialAccountIds: ids,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
  });
}

export async function scheduleContent(params: {
  contentId: number;
  socialAccountIds: number[];
  scheduledAt: string;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);
  if (content.status !== 'APPROVED' && content.status !== 'SCHEDULED') {
    throw new ValidationError('Only APPROVED (or already SCHEDULED) content can be scheduled');
  }
  if (!content.approvedImageVersionId) {
    throw new ValidationError('Content requires an approved image version before scheduling');
  }
  const ids = parseAccountIds(params.socialAccountIds);
  const when = new Date(params.scheduledAt);
  if (Number.isNaN(when.getTime())) {
    throw new ValidationError('scheduledAt must be a valid ISO datetime');
  }
  if (when.getTime() <= Date.now() - 60_000) {
    throw new ValidationError('scheduledAt must be in the future');
  }

  const accounts = await prisma.marketingSocialAccount.count({
    where: { id: { in: ids }, gymId: content.gymId, status: 'CONNECTED' },
  });
  if (accounts !== ids.length) {
    throw new ValidationError(
      'One or more social accounts are missing, disconnected, or not in this gym'
    );
  }

  await prisma.marketingContent.update({
    where: { id: content.id },
    data: {
      status: 'SCHEDULED',
      scheduledAt: when,
      selectedSocialAccountIds: ids as unknown as Prisma.InputJsonValue,
    },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_SCHEDULE',
    targetGymId: content.gymId,
    metadata: {
      contentId: content.id,
      scheduledAt: when.toISOString(),
      socialAccountIds: ids,
    },
  });

  return getContentById(content.id);
}

export async function rescheduleContent(params: {
  contentId: number;
  scheduledAt: string;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);
  if (content.status !== 'SCHEDULED') {
    throw new ValidationError('Only SCHEDULED content can be rescheduled');
  }
  const when = new Date(params.scheduledAt);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() - 60_000) {
    throw new ValidationError('scheduledAt must be a valid future ISO datetime');
  }
  await prisma.marketingContent.update({
    where: { id: content.id },
    data: { scheduledAt: when },
  });
  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_RESCHEDULE',
    targetGymId: content.gymId,
    metadata: { contentId: content.id, scheduledAt: when.toISOString() },
  });
  return getContentById(content.id);
}

export async function cancelSchedule(params: {
  contentId: number;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);
  if (content.status !== 'SCHEDULED') {
    throw new ValidationError('Only SCHEDULED content can cancel schedule');
  }
  await prisma.marketingContent.update({
    where: { id: content.id },
    data: { status: 'APPROVED', scheduledAt: null },
  });
  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_CANCEL_SCHEDULE',
    targetGymId: content.gymId,
    metadata: { contentId: content.id },
  });
  return getContentById(content.id);
}

export async function duplicateContent(params: {
  contentId: number;
  actorUserId: number;
  actorRole: string;
}): Promise<ContentDto> {
  const content = await prisma.marketingContent.findUnique({ where: { id: params.contentId } });
  if (!content) throw new NotFoundError('Content', params.contentId);

  const created = await prisma.marketingContent.create({
    data: {
      gymId: content.gymId,
      opportunityId: content.opportunityId,
      contentKind: content.contentKind,
      title: `${content.title} (copy)`,
      status: 'DRAFT',
      topic: content.topic,
      headline: content.headline,
      caption: content.caption,
      captionShort: content.captionShort,
      cta: content.cta,
      hashtags: content.hashtags,
      imageConcept: content.imageConcept,
      imagePrompt: content.imagePrompt,
      suggestedPlatforms: content.suggestedPlatforms ?? Prisma.JsonNull,
      platformVariants: content.platformVariants ?? Prisma.JsonNull,
    },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_CONTENT_DUPLICATE',
    targetGymId: content.gymId,
    metadata: { sourceContentId: content.id, contentId: created.id },
  });

  return getContentById(created.id);
}

export async function listPublishAttempts(contentId: number): Promise<{
  attempts: PublishAttemptDto[];
}> {
  const content = await prisma.marketingContent.findUnique({
    where: { id: contentId },
    select: { id: true },
  });
  if (!content) throw new NotFoundError('Content', contentId);
  const rows = await prisma.marketingPublishAttempt.findMany({
    where: { contentId },
    orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
  });
  return { attempts: rows.map(toAttemptDto) };
}

export async function retryPublishAttempt(params: {
  attemptId: number;
  actorUserId: number;
  actorRole: string;
}): Promise<{ content: ContentDto; attempt: PublishAttemptDto }> {
  const attempt = await prisma.marketingPublishAttempt.findUnique({
    where: { id: params.attemptId },
  });
  if (!attempt?.contentId || !attempt.socialAccountId) {
    throw new NotFoundError('Publish attempt', params.attemptId);
  }
  if (attempt.status !== 'FAILED') {
    throw new ValidationError('Only FAILED publish attempts can be retried');
  }

  const result = await publishToAccounts({
    content: await prisma.marketingContent.findUniqueOrThrow({
      where: { id: attempt.contentId },
    }),
    socialAccountIds: [attempt.socialAccountId],
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_PUBLISH_RETRY',
    targetGymId: attempt.gymId,
    metadata: { attemptId: attempt.id, contentId: attempt.contentId },
  });

  const latest = result.attempts[result.attempts.length - 1];
  return { content: result.content, attempt: latest };
}

export async function getMarketingCalendar(params: {
  gymId: number;
  from: string;
  to: string;
}): Promise<{
  items: Array<{
    id: number;
    contentId: number;
    gymId: number;
    gymName: string | null;
    title: string;
    platform: string | null;
    status: string;
    scheduledAt: string | null;
    publishedAt: string | null;
    contentKind: string;
  }>;
}> {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError('from and to must be valid ISO datetimes');
  }

  const gym = await prisma.gym.findUnique({
    where: { id: params.gymId },
    select: { id: true, name: true },
  });
  if (!gym) throw new NotFoundError('Gym', params.gymId);

  const rows = await prisma.marketingContent.findMany({
    where: {
      gymId: params.gymId,
      OR: [
        { scheduledAt: { gte: from, lte: to } },
        { publishedAt: { gte: from, lte: to } },
      ],
    },
    orderBy: [{ scheduledAt: 'asc' }, { publishedAt: 'asc' }, { id: 'asc' }],
  });

  return {
    items: rows.map((r) => ({
      id: r.id,
      contentId: r.id,
      gymId: r.gymId,
      gymName: gym.name,
      title: r.title,
      platform: null,
      status: r.status,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      contentKind: r.contentKind,
    })),
  };
}

/** Process due SCHEDULED posts (interval worker / manual job). */
export async function processDueScheduledContent(): Promise<{ processed: number }> {
  const due = await prisma.marketingContent.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { lte: new Date() },
    },
    take: 20,
    orderBy: { scheduledAt: 'asc' },
  });

  let processed = 0;
  for (const content of due) {
    const idsRaw = content.selectedSocialAccountIds;
    const ids = Array.isArray(idsRaw)
      ? idsRaw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (ids.length === 0) {
      await prisma.marketingContent.update({
        where: { id: content.id },
        data: { status: 'FAILED' },
      });
      continue;
    }
    try {
      await publishToAccounts({
        content,
        socialAccountIds: ids,
        actorUserId: 0,
        actorRole: 'SYSTEM',
      });
      processed += 1;
    } catch {
      await prisma.marketingContent.update({
        where: { id: content.id },
        data: { status: 'FAILED' },
      });
    }
  }
  return { processed };
}
