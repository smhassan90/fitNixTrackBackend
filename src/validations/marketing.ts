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

export const marketingGenerateImagePromptSchema = z.object({
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

export const marketingGenerateImageSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      prompt: z.string().max(4000).optional(),
    })
    .optional()
    .default({}),
});

export const marketingRegenerateImageSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      mode: z.enum(['quick', 'custom']),
      instructions: z.string().max(2000).optional(),
      prompt: z.string().max(4000).optional(),
    })
    .strict(),
});

export const marketingImageVersionParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
    imageVersionId: z.coerce.number().int().positive(),
  }),
});

export const marketingRejectImageSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
    imageVersionId: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      reason: z.string().max(2000).optional(),
    })
    .optional()
    .default({}),
});

export const marketingSocialPlatformZ = z.enum([
  'facebook',
  'instagram',
  'linkedin',
  'google_business',
]);

export const marketingSocialAccountsQuerySchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
});

export const marketingSocialConnectSchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      platform: marketingSocialPlatformZ,
    })
    .strict(),
});

export const marketingSocialDisconnectSchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
    accountId: z.coerce.number().int().positive(),
  }),
});

export const marketingOAuthCallbackQuerySchema = z.object({
  params: z.object({
    platform: marketingSocialPlatformZ,
  }),
  query: z.object({
    code: z.string().max(4000).optional(),
    state: z.string().max(4000).optional(),
    error: z.string().max(500).optional(),
    error_description: z.string().max(1000).optional(),
  }),
});

const secretOptionalKeep = z
  .union([z.string().max(4000), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null ? null : v));

export const marketingSettingsUpdateSchema = z.object({
  body: z
    .object({
      portalReturnBaseUrl: z
        .union([z.string().url().max(500), z.literal(''), z.null()])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === '' || v === null ? null : v)),
      websiteBlogExportPath: z
        .union([z.string().max(1000), z.literal(''), z.null()])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === '' || v === null ? null : v.trim())),
      ai: z
        .object({
          provider: z.string().max(64).optional(),
          textModel: z.union([z.string().max(128), z.null()]).optional(),
          imageModel: z.union([z.string().max(128), z.null()]).optional(),
          baseUrl: z
            .union([z.string().url().max(500), z.literal(''), z.null()])
            .optional()
            .transform((v) => (v === undefined ? undefined : v === '' || v === null ? null : v)),
          enabled: z.boolean().optional(),
          apiKey: secretOptionalKeep,
        })
        .strict()
        .optional(),
      oauthApps: z
        .array(
          z
            .object({
              platform: marketingSocialPlatformZ,
              clientId: z.union([z.string().max(255), z.null()]).optional(),
              redirectUri: z
                .union([z.string().url().max(500), z.literal(''), z.null()])
                .optional()
                .transform((v) =>
                  v === undefined ? undefined : v === '' || v === null ? null : v
                ),
              enabled: z.boolean().optional(),
              notes: z.union([z.string().max(2000), z.null()]).optional(),
              clientSecret: secretOptionalKeep,
            })
            .strict()
        )
        .max(20)
        .optional(),
    })
    .strict(),
});

const socialAccountIdsBody = z
  .array(z.coerce.number().int().positive())
  .min(1)
  .max(20);

export const marketingPublishContentSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      socialAccountIds: socialAccountIdsBody,
    })
    .strict(),
});

export const marketingScheduleContentSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      socialAccountIds: socialAccountIdsBody,
      scheduledAt: z.string().datetime({ offset: true }).or(z.string().min(1).max(64)),
    })
    .strict(),
});

export const marketingRescheduleContentSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      scheduledAt: z.string().datetime({ offset: true }).or(z.string().min(1).max(64)),
    })
    .strict(),
});

export const marketingPublishAttemptIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const marketingCalendarQuerySchema = z.object({
  query: z.object({
    gymId: z.coerce.number().int().positive(),
    view: z.enum(['month', 'week', 'day', 'list']).optional(),
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
  }),
});

export const marketingBlogListQuerySchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
  query: z.object({
    status: z
      .enum(['DRAFT', 'AWAITING_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED'])
      .optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
});

export const marketingGenerateBlogSchema = z.object({
  params: z.object({
    gymId: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      topic: z.string().max(500).optional(),
      targetKeyword: z.string().max(255).optional(),
      opportunityId: z.coerce.number().int().positive().optional(),
    })
    .strict(),
});

export const marketingBlogIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const marketingBlogUpdateSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      title: z.string().min(1).max(500).optional(),
      excerpt: optionalNullableText(10000),
      introduction: optionalNullableText(50000),
      bodyHtml: optionalNullableText(200000),
      conclusion: optionalNullableText(20000),
      cta: optionalNullableText(5000),
      seoTitle: optionalNullableText(255),
      metaDescription: optionalNullableText(5000),
      targetKeyword: optionalNullableText(255),
      secondaryKeywords: optionalNullableText(5000),
      internalLinks: optionalNullableText(10000),
      externalReferences: optionalNullableText(10000),
      featuredImageUrl: optionalNullableText(2048),
      imageAlt: optionalNullableText(500),
      author: optionalNullableText(191),
      category: optionalNullableText(120),
      sections: z.unknown().optional(),
      faqJson: z.unknown().optional(),
      readingTimeMinutes: z.coerce.number().int().min(1).max(120).nullable().optional(),
    })
    .strict(),
});

export const MARKETING_BLOG_EDITABLE_FIELDS = [
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
  'sections',
  'faqJson',
  'readingTimeMinutes',
] as const;

export const marketingUsageQuerySchema = z.object({
  query: z.object({
    gymId: z.coerce.number().int().positive(),
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
  }),
});

export const marketingAuditLogQuerySchema = z.object({
  query: z.object({
    gymId: z.coerce.number().int().positive(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    actionType: z.string().max(64).optional(),
  }),
});
