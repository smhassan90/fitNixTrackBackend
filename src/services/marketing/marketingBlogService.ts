import fs from 'fs';
import path from 'path';
import { MarketingBlog, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import {
  callMarketingChatJson,
  parseJsonObject,
  recordMarketingAiUsage,
} from './marketingAiClient';
import { getOrCreateMarketingProfile } from './marketingProfileService';
import { getMarketingSettingsCached } from './marketingSettingsService';

export type WebsiteBlogPost = {
  slug: string;
  title: string;
  excerpt: string;
  description: string;
  category: string;
  author: string;
  datePublished: string;
  dateModified?: string;
  readingTimeMinutes: number;
  image: string;
  imageAlt: string;
  sections: Array<{
    heading: string;
    paragraphs?: string[];
    bullets?: string[];
    subheadings?: { heading: string; paragraphs: string[] }[];
  }>;
};

export type BlogDto = {
  id: number;
  gymId: number | null;
  title: string;
  slug: string;
  excerpt: string | null;
  introduction: string | null;
  bodyHtml: string | null;
  sections: unknown;
  conclusion: string | null;
  cta: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  targetKeyword: string | null;
  secondaryKeywords: string | null;
  internalLinks: string | null;
  externalReferences: string | null;
  featuredImageUrl: string | null;
  imageAlt: string | null;
  author: string | null;
  category: string | null;
  faqJson: unknown;
  status: string;
  publishedAt: string | null;
  websitePublished: boolean;
  readingTimeMinutes: number | null;
  opportunityId: number | null;
  createdAt: string;
  updatedAt: string;
};

function toBlogDto(row: MarketingBlog): BlogDto {
  return {
    id: row.id,
    gymId: row.gymId,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    introduction: row.introduction,
    bodyHtml: row.bodyHtml,
    sections: row.sections,
    conclusion: row.conclusion,
    cta: row.cta,
    seoTitle: row.seoTitle,
    metaDescription: row.metaDescription,
    targetKeyword: row.targetKeyword,
    secondaryKeywords: row.secondaryKeywords,
    internalLinks: row.internalLinks,
    externalReferences: row.externalReferences,
    featuredImageUrl: row.featuredImageUrl,
    imageAlt: row.imageAlt,
    author: row.author,
    category: row.category,
    faqJson: row.faqJson,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    websitePublished: row.websitePublished,
    readingTimeMinutes: row.readingTimeMinutes,
    opportunityId: row.opportunityId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180);
}

async function uniqueSlug(base: string): Promise<string> {
  const slug = slugify(base) || `blog-${Date.now()}`;
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${i}`;
    const exists = await prisma.marketingBlog.findUnique({ where: { slug: candidate } });
    if (!exists) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

export async function listBlogs(params: {
  gymId: number;
  page: number;
  limit: number;
  status?: string;
}): Promise<{ blogs: BlogDto[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const gym = await prisma.gym.findUnique({ where: { id: params.gymId }, select: { id: true } });
  if (!gym) throw new NotFoundError('Gym', params.gymId);
  const where: Prisma.MarketingBlogWhereInput = { gymId: params.gymId };
  if (params.status) where.status = params.status as never;
  const [total, rows] = await Promise.all([
    prisma.marketingBlog.count({ where }),
    prisma.marketingBlog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    }),
  ]);
  return {
    blogs: rows.map(toBlogDto),
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / params.limit)),
    },
  };
}

export async function getBlogById(id: number): Promise<BlogDto> {
  const row = await prisma.marketingBlog.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Blog', id);
  return toBlogDto(row);
}

export async function generateBlog(params: {
  gymId: number;
  topic?: string;
  targetKeyword?: string;
  opportunityId?: number;
  actorUserId: number;
  actorRole: string;
}): Promise<BlogDto> {
  const gym = await prisma.gym.findUnique({
    where: { id: params.gymId },
    select: { id: true, name: true, city: true, country: true },
  });
  if (!gym) throw new NotFoundError('Gym', params.gymId);
  await getOrCreateMarketingProfile(params.gymId);
  const profile = await prisma.marketingProfile.findUniqueOrThrow({
    where: { gymId: params.gymId },
  });

  let opportunity: { id: number; title: string; reason: string | null } | null = null;
  if (params.opportunityId) {
    opportunity = await prisma.marketingContentOpportunity.findFirst({
      where: { id: params.opportunityId, gymId: params.gymId },
      select: { id: true, title: true, reason: true },
    });
  }

  const system = `
You write SEO/AEO-friendly gym marketing blog posts.
HARD RULES:
- Use ONLY facts from the gym marketing profile. No fake stats, reviews, awards, or pricing.
- Return JSON with: title, excerpt, introduction, conclusion, cta, seoTitle, metaDescription,
  targetKeyword, secondaryKeywords (string), category, author, imageAlt,
  sections: [{ heading, paragraphs?: string[], bullets?: string[], subheadings?: [{ heading, paragraphs }] }],
  faq: [{ question, answer }] optional,
  readingTimeMinutes number
`.trim();

  const user = JSON.stringify({
    topic: params.topic || opportunity?.title || null,
    targetKeyword: params.targetKeyword || null,
    opportunity,
    gym: {
      name: gym.name,
      city: gym.city ?? profile.city,
      country: gym.country ?? profile.country,
      description: profile.description,
      services: profile.services,
      targetAudience: profile.targetAudience,
      uniqueSellingPoints: profile.uniqueSellingPoints,
      facilities: profile.facilities,
      doNotClaim: profile.doNotClaim,
      preferredLanguage: profile.preferredLanguage,
      seoTopics: profile.seoTopics,
      keywords: profile.keywords,
    },
  });

  const ai = await callMarketingChatJson({ system, user, temperature: 0.55 });
  await recordMarketingAiUsage({
    gymId: params.gymId,
    platformUserId: params.actorUserId,
    operationType: 'BLOG_GENERATION',
    provider: ai.provider,
    model: ai.model,
    tokens: ai.totalTokens,
    costUsd: ai.costUsd,
  });

  const parsed = parseJsonObject<Record<string, unknown>>(ai.content, 'blog');
  const title =
    (typeof parsed.title === 'string' && parsed.title.trim()) ||
    params.topic ||
    opportunity?.title ||
    `${gym.name} blog`;
  const slug = await uniqueSlug(title);

  const created = await prisma.marketingBlog.create({
    data: {
      gymId: params.gymId,
      title: title.slice(0, 500),
      slug,
      excerpt: typeof parsed.excerpt === 'string' ? parsed.excerpt : null,
      introduction: typeof parsed.introduction === 'string' ? parsed.introduction : null,
      sections: (parsed.sections as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      conclusion: typeof parsed.conclusion === 'string' ? parsed.conclusion : null,
      cta: typeof parsed.cta === 'string' ? parsed.cta : null,
      seoTitle: typeof parsed.seoTitle === 'string' ? parsed.seoTitle.slice(0, 255) : null,
      metaDescription: typeof parsed.metaDescription === 'string' ? parsed.metaDescription : null,
      targetKeyword:
        (typeof parsed.targetKeyword === 'string' && parsed.targetKeyword) ||
        params.targetKeyword ||
        null,
      secondaryKeywords:
        typeof parsed.secondaryKeywords === 'string' ? parsed.secondaryKeywords : null,
      imageAlt: typeof parsed.imageAlt === 'string' ? parsed.imageAlt : null,
      author: typeof parsed.author === 'string' ? parsed.author : 'FitNixTrack Team',
      category: typeof parsed.category === 'string' ? parsed.category : 'Guides',
      faqJson: (parsed.faq as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      readingTimeMinutes:
        typeof parsed.readingTimeMinutes === 'number'
          ? Math.max(1, Math.round(parsed.readingTimeMinutes))
          : 8,
      opportunityId: opportunity?.id ?? null,
      status: 'DRAFT',
    },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_BLOG_GENERATE',
    targetGymId: params.gymId,
    metadata: { blogId: created.id, slug },
  });

  return toBlogDto(created);
}

export async function updateBlog(params: {
  id: number;
  patch: Record<string, unknown>;
  actorUserId: number;
  actorRole: string;
}): Promise<BlogDto> {
  const existing = await prisma.marketingBlog.findUnique({ where: { id: params.id } });
  if (!existing) throw new NotFoundError('Blog', params.id);
  if (existing.status === 'PUBLISHED' && existing.websitePublished) {
    // still allow edits but keep published
  }

  const data: Prisma.MarketingBlogUpdateInput = {};
  const keys = [
    'title',
    'excerpt',
    'introduction',
    'bodyHtml',
    'conclusion',
    'cta',
    'seoTitle',
    'metaDescription',
    'targetKeyword',
    'secondaryKeywords',
    'internalLinks',
    'externalReferences',
    'featuredImageUrl',
    'imageAlt',
    'author',
    'category',
  ] as const;
  const changed: string[] = [];
  for (const key of keys) {
    if (key in params.patch) {
      const v = params.patch[key];
      (data as Record<string, unknown>)[key] =
        v === null || v === undefined ? null : String(v);
      changed.push(key);
    }
  }
  if ('sections' in params.patch) {
    data.sections = params.patch.sections as Prisma.InputJsonValue;
    changed.push('sections');
  }
  if ('faqJson' in params.patch) {
    data.faqJson = params.patch.faqJson as Prisma.InputJsonValue;
    changed.push('faqJson');
  }
  if ('readingTimeMinutes' in params.patch) {
    const n = Number(params.patch.readingTimeMinutes);
    data.readingTimeMinutes = Number.isFinite(n) ? Math.max(1, Math.round(n)) : null;
    changed.push('readingTimeMinutes');
  }

  const updated = await prisma.marketingBlog.update({ where: { id: params.id }, data });
  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_BLOG_UPDATE',
    targetGymId: existing.gymId,
    metadata: { blogId: existing.id, changedFields: changed },
  });
  return toBlogDto(updated);
}

export async function approveBlog(params: {
  id: number;
  actorUserId: number;
  actorRole: string;
}): Promise<BlogDto> {
  const existing = await prisma.marketingBlog.findUnique({ where: { id: params.id } });
  if (!existing) throw new NotFoundError('Blog', params.id);
  if (existing.status !== 'DRAFT' && existing.status !== 'AWAITING_REVIEW') {
    throw new ValidationError('Only DRAFT or AWAITING_REVIEW blogs can be approved');
  }
  const updated = await prisma.marketingBlog.update({
    where: { id: params.id },
    data: { status: 'APPROVED' },
  });
  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_BLOG_APPROVE',
    targetGymId: existing.gymId,
    metadata: { blogId: existing.id },
  });
  return toBlogDto(updated);
}

function toWebsiteBlogPost(row: MarketingBlog): WebsiteBlogPost {
  const sections = Array.isArray(row.sections) ? (row.sections as WebsiteBlogPost['sections']) : [];
  const date = (row.publishedAt || row.updatedAt || new Date()).toISOString().slice(0, 10);
  return {
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || '',
    description: row.metaDescription || row.excerpt || row.title,
    category: row.category || 'Guides',
    author: row.author || 'FitNixTrack Team',
    datePublished: date,
    dateModified: row.updatedAt.toISOString().slice(0, 10),
    readingTimeMinutes: row.readingTimeMinutes || 8,
    image: row.featuredImageUrl || '/og-default.jpg',
    imageAlt: row.imageAlt || row.title,
    sections,
  };
}

async function syncWebsiteBlogExportFile(): Promise<string | null> {
  const settings = await getMarketingSettingsCached();
  const exportPath = settings.websiteBlogExportPath?.trim();
  if (!exportPath) return null;

  const published = await prisma.marketingBlog.findMany({
    where: { websitePublished: true, status: 'PUBLISHED' },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
  });
  const posts = published.map(toWebsiteBlogPost);
  const abs = path.isAbsolute(exportPath)
    ? exportPath
    : path.resolve(process.cwd(), exportPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
  return abs;
}

export async function publishBlogToWebsite(params: {
  id: number;
  actorUserId: number;
  actorRole: string;
}): Promise<{ blog: BlogDto; exportPath: string | null; websitePost: WebsiteBlogPost }> {
  const existing = await prisma.marketingBlog.findUnique({ where: { id: params.id } });
  if (!existing) throw new NotFoundError('Blog', params.id);
  if (existing.status !== 'APPROVED' && existing.status !== 'PUBLISHED') {
    throw new ValidationError('Blog must be APPROVED before publishing to website');
  }

  const updated = await prisma.marketingBlog.update({
    where: { id: params.id },
    data: {
      status: 'PUBLISHED',
      websitePublished: true,
      publishedAt: existing.publishedAt ?? new Date(),
    },
  });

  let exportPath: string | null = null;
  try {
    exportPath = await syncWebsiteBlogExportFile();
  } catch (error) {
    // DB publish succeeded; export path may be misconfigured
    exportPath = null;
    void error;
  }

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_BLOG_PUBLISH_WEBSITE',
    targetGymId: existing.gymId,
    metadata: { blogId: existing.id, slug: existing.slug, exportPath },
  });

  return {
    blog: toBlogDto(updated),
    exportPath,
    websitePost: toWebsiteBlogPost(updated),
  };
}

/** Public website-shaped posts (no secrets). */
export async function listWebsitePublishedBlogs(): Promise<WebsiteBlogPost[]> {
  const rows = await prisma.marketingBlog.findMany({
    where: { websitePublished: true, status: 'PUBLISHED' },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map(toWebsiteBlogPost);
}
