import { z } from 'zod';

const optionalNullableText = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null ? null : v.trim() === '' ? null : v.trim()));

export const marketingGymListQuerySchema = z.object({
  query: z.object({
    search: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
});

export const marketingGymIdParamSchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
});

export const marketingProfileUpdateSchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      description: optionalNullableText(10000),
      location: optionalNullableText(255),
      city: optionalNullableText(120),
      country: optionalNullableText(120),
      address: optionalNullableText(2000),
      phone: optionalNullableText(40),
      website: optionalNullableText(500),
      services: optionalNullableText(10000),
      membershipPackages: optionalNullableText(10000),
      targetAudience: optionalNullableText(10000),
      uniqueSellingPoints: optionalNullableText(10000),
      facilities: optionalNullableText(10000),
      trainers: optionalNullableText(10000),
      promotions: optionalNullableText(10000),
      brandTone: optionalNullableText(255),
      preferredLanguage: optionalNullableText(64),
      keywords: optionalNullableText(10000),
      seoTopics: optionalNullableText(10000),
      doNotClaim: optionalNullableText(10000),
      additionalInstructions: optionalNullableText(10000),
    })
    .strict(),
});

export const MARKETING_PROFILE_FIELDS = [
  'description',
  'location',
  'city',
  'country',
  'address',
  'phone',
  'website',
  'services',
  'membershipPackages',
  'targetAudience',
  'uniqueSellingPoints',
  'facilities',
  'trainers',
  'promotions',
  'brandTone',
  'preferredLanguage',
  'keywords',
  'seoTopics',
  'doNotClaim',
  'additionalInstructions',
] as const;

export type MarketingProfileField = (typeof MARKETING_PROFILE_FIELDS)[number];

const opportunityStatusZ = z.enum([
  'DRAFT',
  'AWAITING_REVIEW',
  'APPROVED',
  'REJECTED',
  'CONVERTED',
]);

const contentStatusZ = z.enum([
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHED',
  'FAILED',
  'REJECTED',
]);

export const marketingOpportunityListQuerySchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    status: opportunityStatusZ.optional(),
  }),
});

export const marketingGenerateOpportunitiesSchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      count: z.coerce.number().int().min(1).max(10).optional(),
      focus: z.string().max(500).optional(),
    })
    .optional()
    .default({}),
});

export const marketingOpportunityIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const marketingRejectOpportunitySchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      reason: z.string().max(2000).optional(),
    })
    .optional()
    .default({}),
});

export const marketingGenerateSocialPostSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      notes: z.string().max(2000).optional(),
    })
    .optional()
    .default({}),
});

export const marketingContentListQuerySchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    status: contentStatusZ.optional(),
    opportunityId: z.coerce.number().int().positive().optional(),
  }),
});

export const marketingContentIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

const platformVariantsSchema = z
  .object({
    facebook: z.string().max(8000).optional(),
    instagram: z.string().max(8000).optional(),
    linkedin: z.string().max(8000).optional(),
    googleBusiness: z.string().max(8000).optional(),
  })
  .strict()
  .nullable()
  .optional();

export const marketingContentUpdateSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      title: optionalNullableText(255),
      topic: optionalNullableText(2000),
      headline: optionalNullableText(500),
      caption: optionalNullableText(8000),
      captionShort: optionalNullableText(1000),
      cta: optionalNullableText(500),
      hashtags: optionalNullableText(2000),
      imageConcept: optionalNullableText(4000),
      imagePrompt: optionalNullableText(4000),
      suggestedPlatforms: z.array(z.string().max(64)).max(8).nullable().optional(),
      platformVariants: platformVariantsSchema,
    })
    .strict(),
});

export const marketingRejectContentSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      reason: z.string().max(2000).optional(),
    })
    .optional()
    .default({}),
});
