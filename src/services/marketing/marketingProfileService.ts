import { MarketingProfile, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import {
  MARKETING_PROFILE_FIELDS,
  MarketingProfileField,
} from '../../validations/marketing';

export type MarketingProfileDto = {
  id: number;
  gymId: number;
  gymName: string;
  description: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  services: string | null;
  membershipPackages: string | null;
  targetAudience: string | null;
  uniqueSellingPoints: string | null;
  facilities: string | null;
  trainers: string | null;
  promotions: string | null;
  brandTone: string | null;
  preferredLanguage: string | null;
  keywords: string | null;
  seoTopics: string | null;
  doNotClaim: string | null;
  additionalInstructions: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * profileComplete heuristic: profile exists AND at least one of
 * description | services | targetAudience is non-empty after trim.
 */
export function isMarketingProfileComplete(
  profile: Pick<MarketingProfile, 'description' | 'services' | 'targetAudience'> | null | undefined
): boolean {
  if (!profile) return false;
  return (
    filled(profile.description) ||
    filled(profile.services) ||
    filled(profile.targetAudience)
  );
}

export function toMarketingProfileDto(
  profile: MarketingProfile,
  gymName: string
): MarketingProfileDto {
  return {
    id: profile.id,
    gymId: profile.gymId,
    gymName,
    description: profile.description,
    location: profile.location,
    city: profile.city,
    country: profile.country,
    address: profile.address,
    phone: profile.phone,
    website: profile.website,
    services: profile.services,
    membershipPackages: profile.membershipPackages,
    targetAudience: profile.targetAudience,
    uniqueSellingPoints: profile.uniqueSellingPoints,
    facilities: profile.facilities,
    trainers: profile.trainers,
    promotions: profile.promotions,
    brandTone: profile.brandTone,
    preferredLanguage: profile.preferredLanguage,
    keywords: profile.keywords,
    seoTopics: profile.seoTopics,
    doNotClaim: profile.doNotClaim,
    additionalInstructions: profile.additionalInstructions,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

async function requireGym(gymId: number) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      address: true,
      phone: true,
    },
  });
  if (!gym) {
    throw new NotFoundError('Gym', gymId);
  }
  return gym;
}

function normalizeComparable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/** GET profile: upsert seeded from Gym core fields when missing. */
export async function getOrCreateMarketingProfile(gymId: number): Promise<{
  dto: MarketingProfileDto;
  created: boolean;
}> {
  const gym = await requireGym(gymId);

  const existing = await prisma.marketingProfile.findUnique({
    where: { gymId },
  });
  if (existing) {
    return { dto: toMarketingProfileDto(existing, gym.name), created: false };
  }

  const created = await prisma.marketingProfile.create({
    data: {
      gymId,
      city: gym.city,
      country: gym.country,
      address: gym.address,
      phone: gym.phone,
      location: [gym.city, gym.country].filter(Boolean).join(', ') || null,
    },
  });

  return { dto: toMarketingProfileDto(created, gym.name), created: true };
}

export async function updateMarketingProfile(params: {
  gymId: number;
  actorUserId: number;
  actorRole: string;
  patch: Partial<Record<MarketingProfileField, string | null | undefined>>;
}): Promise<MarketingProfileDto> {
  const { gymId, actorUserId, actorRole, patch } = params;
  const gym = await requireGym(gymId);

  const existing = await prisma.marketingProfile.findUnique({
    where: { gymId },
  });

  const fieldUpdates: Partial<Record<MarketingProfileField, string | null>> = {};
  const changedKeys: MarketingProfileField[] = [];

  for (const key of MARKETING_PROFILE_FIELDS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const next = normalizeComparable(patch[key]);
    const prev = existing ? normalizeComparable(existing[key]) : null;
    if (next !== prev) {
      fieldUpdates[key] = next;
      changedKeys.push(key);
    }
  }

  let profile: MarketingProfile;
  let actionType: 'MARKETING_PROFILE_CREATE' | 'MARKETING_PROFILE_UPDATE' | null = null;

  if (!existing) {
    const seedLocation = [gym.city, gym.country].filter(Boolean).join(', ') || null;
    profile = await prisma.marketingProfile.create({
      data: {
        gymId,
        city: fieldUpdates.city !== undefined ? fieldUpdates.city : gym.city,
        country: fieldUpdates.country !== undefined ? fieldUpdates.country : gym.country,
        address: fieldUpdates.address !== undefined ? fieldUpdates.address : gym.address,
        phone: fieldUpdates.phone !== undefined ? fieldUpdates.phone : gym.phone,
        location: fieldUpdates.location !== undefined ? fieldUpdates.location : seedLocation,
        description: fieldUpdates.description ?? null,
        website: fieldUpdates.website ?? null,
        services: fieldUpdates.services ?? null,
        membershipPackages: fieldUpdates.membershipPackages ?? null,
        targetAudience: fieldUpdates.targetAudience ?? null,
        uniqueSellingPoints: fieldUpdates.uniqueSellingPoints ?? null,
        facilities: fieldUpdates.facilities ?? null,
        trainers: fieldUpdates.trainers ?? null,
        promotions: fieldUpdates.promotions ?? null,
        brandTone: fieldUpdates.brandTone ?? null,
        preferredLanguage: fieldUpdates.preferredLanguage ?? null,
        keywords: fieldUpdates.keywords ?? null,
        seoTopics: fieldUpdates.seoTopics ?? null,
        doNotClaim: fieldUpdates.doNotClaim ?? null,
        additionalInstructions: fieldUpdates.additionalInstructions ?? null,
      },
    });
    actionType = 'MARKETING_PROFILE_CREATE';
  } else if (changedKeys.length === 0) {
    return toMarketingProfileDto(existing, gym.name);
  } else {
    profile = await prisma.marketingProfile.update({
      where: { gymId },
      data: fieldUpdates as Prisma.MarketingProfileUpdateInput,
    });
    actionType = 'MARKETING_PROFILE_UPDATE';
  }

  await writePlatformAuditLog({
    actorUserId,
    actorRole,
    actionType,
    targetGymId: gymId,
    metadata: {
      changedFields: changedKeys,
    },
  });

  return toMarketingProfileDto(profile, gym.name);
}
