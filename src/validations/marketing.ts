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
