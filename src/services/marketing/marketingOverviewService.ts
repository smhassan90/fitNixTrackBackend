import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError } from '../../utils/errors';
import { isMarketingProfileComplete } from './marketingProfileService';

export type MarketingGymListItem = {
  id: number;
  name: string;
  slug: string | null;
  city: string | null;
  country: string | null;
  tenantStatus: string;
  logoUrl: string | null;
  hasMarketingProfile: boolean;
  connectedAccountsCount: number;
};

export type MarketingGymListResult = {
  gyms: MarketingGymListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export async function listMarketingGyms(params: {
  page: number;
  limit: number;
  search?: string;
}): Promise<MarketingGymListResult> {
  const { page, limit } = params;
  const search = params.search?.trim();

  const where: Prisma.GymWhereInput = {
    tenantStatus: { in: ['ACTIVE', 'SUSPENDED'] },
  };
  if (search) {
    where.AND = [
      {
        OR: [
          { name: { contains: search } },
          { city: { contains: search } },
          { slug: { contains: search } },
        ],
      },
    ];
  }

  const [total, gyms] = await Promise.all([
    prisma.gym.count({ where }),
    prisma.gym.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        city: true,
        country: true,
        tenantStatus: true,
        logoUrl: true,
        marketingProfile: { select: { id: true } },
        _count: {
          select: {
            marketingSocialAccounts: {
              where: { status: 'CONNECTED' },
            },
          },
        },
      },
    }),
  ]);

  return {
    gyms: gyms.map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      city: g.city,
      country: g.country,
      tenantStatus: g.tenantStatus,
      logoUrl: g.logoUrl,
      hasMarketingProfile: Boolean(g.marketingProfile),
      connectedAccountsCount: g._count.marketingSocialAccounts,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

export type MarketingOverviewResult = {
  gym: {
    id: number;
    name: string;
    city: string | null;
    country: string | null;
    logoUrl: string | null;
  };
  profileComplete: boolean;
  profileUpdatedAt: string | null;
  contentThisMonth: {
    socialPosts: number;
    blogs: number;
    googleBusinessPosts: number;
    scheduledPosts: number;
    publishedPosts: number;
    failedPosts: number;
  };
  aiActivity: {
    textGenerations: number;
    imageGenerations: number;
    estimatedCostUsd: number | null;
  };
  attention: Array<{
    type: string;
    message: string;
    href?: string;
    severity?: 'info' | 'warning' | 'error';
  }>;
  recommendations: string[];
  connectedAccountsCount: number;
  opportunitiesAwaitingReview: number;
  postsAwaitingApproval: number;
};

function startOfUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

export async function getMarketingOverview(gymId: number): Promise<MarketingOverviewResult> {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      logoUrl: true,
      marketingProfile: true,
    },
  });
  if (!gym) {
    throw new NotFoundError('Gym', gymId);
  }

  const monthStart = startOfUtcMonth();

  const [
    connectedAccountsCount,
    opportunitiesAwaitingReview,
    postsAwaitingApproval,
    aiRows,
    socialPostsThisMonth,
    scheduledThisMonth,
    publishedThisMonth,
    failedThisMonth,
  ] = await Promise.all([
    prisma.marketingSocialAccount.count({
      where: { gymId, status: 'CONNECTED' },
    }),
    prisma.marketingContentOpportunity.count({
      where: { gymId, status: 'AWAITING_REVIEW' },
    }),
    prisma.marketingContent.count({
      where: { gymId, status: 'AWAITING_APPROVAL' },
    }),
    prisma.marketingAiUsage.findMany({
      where: {
        gymId,
        createdAt: { gte: monthStart },
        operationType: {
          in: [
            'OPPORTUNITY_GENERATION',
            'SOCIAL_POST_GENERATION',
            'IMAGE_PROMPT_GENERATION',
            'IMAGE_GENERATION',
            'REGENERATION',
          ],
        },
      },
      select: { operationType: true, costUsd: true },
    }),
    prisma.marketingContent.count({
      where: {
        gymId,
        contentKind: 'SOCIAL_POST',
        createdAt: { gte: monthStart },
      },
    }),
    prisma.marketingContent.count({
      where: {
        gymId,
        status: 'SCHEDULED',
        updatedAt: { gte: monthStart },
      },
    }),
    prisma.marketingContent.count({
      where: {
        gymId,
        status: 'PUBLISHED',
        updatedAt: { gte: monthStart },
      },
    }),
    prisma.marketingContent.count({
      where: {
        gymId,
        status: 'FAILED',
        updatedAt: { gte: monthStart },
      },
    }),
  ]);

  let textGenerations = 0;
  let imageGenerations = 0;
  let costSum = 0;
  let hasCost = false;
  for (const row of aiRows) {
    const op = row.operationType;
    if (op === 'IMAGE_GENERATION' || op === 'REGENERATION') {
      imageGenerations += 1;
    } else if (
      op === 'OPPORTUNITY_GENERATION' ||
      op === 'SOCIAL_POST_GENERATION' ||
      op === 'IMAGE_PROMPT_GENERATION'
    ) {
      textGenerations += 1;
    }
    if (row.costUsd != null) {
      costSum += row.costUsd;
      hasCost = true;
    }
  }

  const profile = gym.marketingProfile;
  const profileComplete = isMarketingProfileComplete(profile);

  const attention: MarketingOverviewResult['attention'] = [];
  const recommendations: string[] = [];

  if (!profile || !profileComplete) {
    attention.push({
      type: 'PROFILE_INCOMPLETE',
      message: 'Complete the marketing profile to unlock content recommendations.',
      href: `/platform/marketing/${gymId}/profile`,
      severity: 'warning',
    });
    recommendations.push('Complete the marketing profile for this gym.');
  }

  if (opportunitiesAwaitingReview > 0) {
    attention.push({
      type: 'OPPORTUNITIES_AWAITING_REVIEW',
      message: `${opportunitiesAwaitingReview} content opportunit${
        opportunitiesAwaitingReview === 1 ? 'y' : 'ies'
      } awaiting review.`,
      href: `/platform/marketing/${gymId}/opportunities`,
      severity: 'info',
    });
    recommendations.push('Review and approve pending content opportunities.');
  }

  if (postsAwaitingApproval > 0) {
    attention.push({
      type: 'POSTS_AWAITING_APPROVAL',
      message: `${postsAwaitingApproval} social post${
        postsAwaitingApproval === 1 ? '' : 's'
      } awaiting approval.`,
      href: `/platform/marketing/${gymId}/contents`,
      severity: 'info',
    });
    recommendations.push('Approve or reject draft social posts.');
  }

  if (connectedAccountsCount === 0) {
    recommendations.push('Connect Facebook, Instagram, LinkedIn, or Google Business accounts.');
  }

  return {
    gym: {
      id: gym.id,
      name: gym.name,
      city: gym.city,
      country: gym.country,
      logoUrl: gym.logoUrl,
    },
    profileComplete,
    profileUpdatedAt: profile?.updatedAt?.toISOString() ?? null,
    contentThisMonth: {
      socialPosts: socialPostsThisMonth,
      blogs: 0,
      googleBusinessPosts: 0,
      scheduledPosts: scheduledThisMonth,
      publishedPosts: publishedThisMonth,
      failedPosts: failedThisMonth,
    },
    aiActivity: {
      textGenerations,
      imageGenerations,
      estimatedCostUsd: hasCost ? costSum : null,
    },
    attention,
    recommendations,
    connectedAccountsCount,
    opportunitiesAwaitingReview,
    postsAwaitingApproval,
  };
}
