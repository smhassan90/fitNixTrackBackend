import { z } from 'zod';
import { WORKOUT_BODY_PARTS } from '../constants/bodyParts';

const bodyPartSchema = z.enum(WORKOUT_BODY_PARTS as unknown as [string, ...string[]]);

export const mobileRequestOtpSchema = z.object({
  body: z.object({
    phone: z.string().min(7).max(20),
    gymSlug: z.string().min(1).max(64).optional(),
    gymId: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileVerifyOtpSchema = z.object({
  body: z.object({
    phone: z.string().min(7).max(20),
    otp: z.string().min(4).max(8),
    gymSlug: z.string().min(1).max(64).optional(),
    gymId: z.coerce.number().int().positive().optional(),
    accountType: z.enum(['MEMBER', 'TRAINER']),
    accountId: z.coerce.number().int().positive(),
  }),
});

export const mobileLookupGymsSchema = z.object({
  query: z.object({
    phone: z.string().min(7).max(20),
  }),
});

export const mobileGoogleAuthSchema = z.object({
  body: z.object({
    idToken: z.string().min(20),
  }),
});

export const mobileGoogleSelectSchema = z.object({
  body: z.object({
    idToken: z.string().min(20),
    accountType: z.enum(['MEMBER', 'TRAINER']),
    accountId: z.coerce.number().int().positive(),
  }),
});

export const mobileGoogleSelectGymSchema = z.object({
  body: z.object({
    idToken: z.string().min(20),
    gymId: z.coerce.number().int().positive(),
  }),
});

/** TEMPORARY: Expo Go testing without native Google Sign-In. */
export const mobileDevLoginSchema = z.object({
  body: z.object({
    email: z.string().email().max(191),
    gymId: z.coerce.number().int().positive().optional(),
    accountType: z.enum(['MEMBER', 'TRAINER']).optional(),
    accountId: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileWorkoutUpsertSchema = z.object({
  body: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    bodyParts: z.array(bodyPartSchema).min(1),
    notes: z.string().max(500).optional().nullable(),
    memberId: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileWorkoutListSchema = z.object({
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    memberId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileWorkoutDateParamSchema = z.object({
  params: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  query: z.object({
    memberId: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileWorkoutIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const mobileAnalyticsSchema = z.object({
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    memberId: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileOrderCreateSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          productId: z.coerce.number().int().positive(),
          quantity: z.coerce.number().int().min(1).max(99),
        })
      )
      .min(1),
    notes: z.string().max(500).optional().nullable(),
    memberId: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileOrderListSchema = z.object({
  query: z.object({
    status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED']).optional(),
    memberId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileOrderIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const mobileOrderCancelSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    reason: z.string().max(255).optional(),
  }),
});

export const mobileProductsSchema = z.object({
  query: z.object({
    productType: z.enum(['NUTRIENT', 'ACCESSORY']).optional(),
    search: z.string().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileProductIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const mobileAttendanceSchema = z.object({
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    memberId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
});

export const mobilePaymentsSchema = z.object({
  query: z.object({
    status: z.enum(['PENDING', 'PAID', 'OVERDUE']).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    memberId: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileNotificationsSchema = z.object({
  query: z.object({
    unreadOnly: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileNotificationIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const mobilePushTokenSchema = z.object({
  body: z.object({
    deviceToken: z.string().min(10).max(512),
    platform: z.enum(['ios', 'android']),
  }),
});

export const mobilePortalOrderListSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
});

export const mobilePortalOrderCompleteSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const mobilePortalOrderCancelSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    reason: z.string().max(255).optional(),
  }),
});

export const mobileTrainerMembersSchema = z.object({
  query: z.object({
    search: z.string().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
});

export const mobileTrainerMembersActivitySchema = z.object({
  query: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});

export const mobileTrainerMemberIdParamSchema = z.object({
  params: z.object({
    memberId: z.coerce.number().int().positive(),
  }),
});
