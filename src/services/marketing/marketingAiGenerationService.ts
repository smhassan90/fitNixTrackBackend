import { MarketingProfile } from '@prisma/client';
import { isMarketingProfileComplete } from './marketingProfileService';
import {
  callMarketingChatJson,
  parseJsonObject,
  recordMarketingAiUsage,
} from './marketingAiClient';
import { ValidationError } from '../../utils/errors';

export type ProfileContext = {
  gymName: string;
  city: string | null;
  country: string | null;
  address: string | null;
  phone: string | null;
  profile: MarketingProfile;
};

export type OpportunityDraft = {
  title: string;
  reason: string;
  audience: string | null;
  contentType: string | null;
  suggestedPlatform: string | null;
  seoIntent: string | null;
  priority: number;
  keywords: string | null;
};

export type SocialPostDraft = {
  title: string;
  topic: string | null;
  headline: string | null;
  caption: string;
  captionShort: string | null;
  cta: string | null;
  hashtags: string | null;
  imageConcept: string | null;
  imagePrompt: string | null;
  suggestedPlatforms: string[];
  platformVariants: {
    facebook?: string;
    instagram?: string;
    linkedin?: string;
    googleBusiness?: string;
  };
};

const FACT_RULES = `
HARD RULES:
- Use ONLY facts present in the gym marketing profile and gym fields provided.
- Do NOT invent reviews, ratings, awards, member counts, pricing, facilities, trainers, or promotions.
- If a detail is missing, omit it or speak generally without fabricating.
- No keyword stuffing. Prefer specific, useful topics for this gym.
- Respect doNotClaim and additionalInstructions when present.
- Prefer the preferredLanguage when set; otherwise English.
- Output valid JSON only.
`.trim();

function profilePayload(ctx: ProfileContext) {
  const p = ctx.profile;
  return {
    gymName: ctx.gymName,
    city: ctx.city ?? p.city,
    country: ctx.country ?? p.country,
    address: ctx.address ?? p.address,
    phone: ctx.phone ?? p.phone,
    description: p.description,
    location: p.location,
    website: p.website,
    services: p.services,
    membershipPackages: p.membershipPackages,
    targetAudience: p.targetAudience,
    uniqueSellingPoints: p.uniqueSellingPoints,
    facilities: p.facilities,
    trainers: p.trainers,
    promotions: p.promotions,
    brandTone: p.brandTone,
    preferredLanguage: p.preferredLanguage,
    keywords: p.keywords,
    seoTopics: p.seoTopics,
    doNotClaim: p.doNotClaim,
    additionalInstructions: p.additionalInstructions,
  };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isNearDuplicateTitle(candidate: string, existing: string[]): boolean {
  const c = normalizeTitle(candidate);
  if (!c) return true;
  for (const e of existing) {
    const n = normalizeTitle(e);
    if (!n) continue;
    if (c === n) return true;
    if (c.includes(n) || n.includes(c)) return true;
    const cTokens = new Set(c.split(' ').filter((t) => t.length > 2));
    const eTokens = n.split(' ').filter((t) => t.length > 2);
    if (eTokens.length === 0) continue;
    const overlap = eTokens.filter((t) => cTokens.has(t)).length;
    if (overlap / eTokens.length >= 0.75 && Math.abs(cTokens.size - eTokens.length) <= 2) {
      return true;
    }
  }
  return false;
}

function asString(v: unknown, max = 2000): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function asPriority(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function validateOpportunityDraft(raw: unknown): OpportunityDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = asString(o.title, 255);
  const reason = asString(o.reason, 4000);
  if (!title || !reason) return null;
  return {
    title,
    reason,
    audience: asString(o.audience, 2000),
    contentType: asString(o.contentType, 64) ?? 'SOCIAL_POST',
    suggestedPlatform: asString(o.suggestedPlatform, 64),
    seoIntent: asString(o.seoIntent, 2000),
    priority: asPriority(o.priority),
    keywords: asString(o.keywords, 2000),
  };
}

function validateSocialPostDraft(raw: unknown): SocialPostDraft {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('AI social post response was not an object');
  }
  const o = raw as Record<string, unknown>;
  const title = asString(o.title, 255);
  const caption = asString(o.caption, 8000);
  if (!title || !caption) {
    throw new ValidationError('AI social post missing title or caption');
  }

  const platformsRaw = o.suggestedPlatforms;
  const suggestedPlatforms = Array.isArray(platformsRaw)
    ? platformsRaw
        .map((p) => asString(p, 64))
        .filter((p): p is string => Boolean(p))
        .slice(0, 8)
    : [];

  const variantsRaw =
    o.platformVariants && typeof o.platformVariants === 'object'
      ? (o.platformVariants as Record<string, unknown>)
      : {};

  return {
    title,
    topic: asString(o.topic, 2000),
    headline: asString(o.headline, 500),
    caption,
    captionShort: asString(o.captionShort, 1000),
    cta: asString(o.cta, 500),
    hashtags: asString(o.hashtags, 2000),
    imageConcept: asString(o.imageConcept, 4000),
    imagePrompt: asString(o.imagePrompt, 4000),
    suggestedPlatforms:
      suggestedPlatforms.length > 0
        ? suggestedPlatforms
        : ['facebook', 'instagram', 'googleBusiness'],
    platformVariants: {
      facebook: asString(variantsRaw.facebook, 8000) ?? undefined,
      instagram: asString(variantsRaw.instagram, 8000) ?? undefined,
      linkedin: asString(variantsRaw.linkedin, 8000) ?? undefined,
      googleBusiness: asString(variantsRaw.googleBusiness, 8000) ?? undefined,
    },
  };
}

export async function generateOpportunities(
  ctx: ProfileContext,
  opts: {
    count?: number;
    focus?: string;
    existingTitles: string[];
    platformUserId?: number | null;
  }
): Promise<{
  drafts: OpportunityDraft[];
  provider: string;
  model: string;
}> {
  const requested = Math.max(1, Math.min(10, opts.count ?? 5));
  const sparse = !isMarketingProfileComplete(ctx.profile);
  const targetCount = sparse ? Math.min(requested, 3) : requested;

  const system = `${FACT_RULES}

You generate marketing content opportunities for a gym.
Return JSON: { "opportunities": [ { "title", "reason", "audience", "contentType", "suggestedPlatform", "seoIntent", "priority", "keywords" } ] }
- contentType is usually SOCIAL_POST
- suggestedPlatform one of: facebook, instagram, linkedin, googleBusiness, or null
- priority 0-100
- If the profile is sparse, generate fewer safer ideas and say so clearly in each reason.
- Avoid topics that duplicate existingTitles.`;

  const user = JSON.stringify({
    requestedCount: targetCount,
    profileSparse: sparse,
    focus: opts.focus?.trim() || null,
    existingTitles: opts.existingTitles.slice(0, 50),
    gym: profilePayload(ctx),
  });

  const ai = await callMarketingChatJson({ system, user, temperature: 0.55 });
  await recordMarketingAiUsage({
    gymId: ctx.profile.gymId,
    platformUserId: opts.platformUserId,
    operationType: 'OPPORTUNITY_GENERATION',
    provider: ai.provider,
    model: ai.model,
    tokens: ai.totalTokens,
    costUsd: ai.costUsd,
  });

  const parsed = parseJsonObject<{ opportunities?: unknown }>(ai.content, 'opportunities');
  const list = Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
  const accepted: OpportunityDraft[] = [];
  const titles = [...opts.existingTitles];

  for (const item of list) {
    if (accepted.length >= targetCount) break;
    const draft = validateOpportunityDraft(item);
    if (!draft) continue;
    if (isNearDuplicateTitle(draft.title, titles)) continue;
    accepted.push(draft);
    titles.push(draft.title);
  }

  return { drafts: accepted, provider: ai.provider, model: ai.model };
}

export async function generateSocialPost(
  ctx: ProfileContext,
  opportunity: {
    id: number;
    title: string;
    reason: string | null;
    audience: string | null;
    contentType: string | null;
    suggestedPlatform: string | null;
    seoIntent: string | null;
    keywords: string | null;
  },
  opts: {
    notes?: string;
    platformUserId?: number | null;
  }
): Promise<{
  draft: SocialPostDraft;
  provider: string;
  model: string;
}> {
  const system = `${FACT_RULES}

You write a social media post draft for a gym based on one approved opportunity.
Return JSON:
{
  "title", "topic", "headline", "caption", "captionShort", "cta", "hashtags",
  "imageConcept", "imagePrompt",
  "suggestedPlatforms": ["facebook","instagram","linkedin","googleBusiness"],
  "platformVariants": {
    "facebook": "longer conversational caption",
    "instagram": "hashtag-friendly caption",
    "linkedin": "professional caption",
    "googleBusiness": "concise local caption"
  }
}
- imageConcept and imagePrompt are TEXT ONLY (no image generation).
- Do not claim fake offers, prices, or reviews.
- Never mark content as published.`;

  const user = JSON.stringify({
    notes: opts.notes?.trim() || null,
    opportunity,
    gym: profilePayload(ctx),
  });

  const ai = await callMarketingChatJson({ system, user, temperature: 0.65 });
  await recordMarketingAiUsage({
    gymId: ctx.profile.gymId,
    platformUserId: opts.platformUserId,
    operationType: 'SOCIAL_POST_GENERATION',
    provider: ai.provider,
    model: ai.model,
    tokens: ai.totalTokens,
    costUsd: ai.costUsd,
  });

  const parsed = parseJsonObject<unknown>(ai.content, 'social post');
  return {
    draft: validateSocialPostDraft(parsed),
    provider: ai.provider,
    model: ai.model,
  };
}
