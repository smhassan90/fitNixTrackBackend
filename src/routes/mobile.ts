import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  authenticateMobileToken,
  MobileAuthRequest,
  requireTrainer,
  requireGymLinked,
} from '../middleware/mobileAuth';
import { validate } from '../middleware/validation';
import { sendSuccess, sendError, buildPagination } from '../utils/response';
import { jwtSignOptions } from '../utils/jwtExpiresIn';
import { UnauthorizedError } from '../utils/errors';
import { WORKOUT_BODY_PARTS, BODY_PART_LABELS } from '../constants/bodyParts';
import {
  requestMobileOtp,
  verifyMobileOtp,
  logoutMobileUser,
  lookupGymsByPhone,
} from '../services/mobileOtpService';
import {
  loginWithGoogleIdToken,
  selectGoogleAccount,
  selectGoogleGym,
  logoutGoogleGuest,
  loginWithDevEmail,
  isDevLoginEnabled,
} from '../services/mobileGoogleAuthService';
import { upsertWorkout, listWorkouts, getWorkoutByDate, deleteWorkout } from '../services/mobileWorkoutService';
import {
  upsertGuestWorkout,
  listGuestWorkouts,
  getGuestWorkoutByDate,
  deleteGuestWorkout,
  getGuestWorkoutAnalytics,
} from '../services/mobileGuestWorkoutService';
import { getCombinedAnalytics } from '../services/mobileAnalyticsService';
import {
  createMobileOrder,
  listMobileOrders,
  getMobileOrder,
  cancelMobileOrder,
} from '../services/mobileOrderService';
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  registerPushToken,
  syncPaymentNotifications,
} from '../services/mobileNotificationService';
import {
  getMemberAttendance,
  getMemberPayments,
  listTrainerMembers,
  getTrainerMemberOverview,
  getTrainerMembersDailyActivity,
  assertTrainerMemberAccess,
} from '../services/mobileMemberService';
import { listGymProducts } from '../services/pos/posProductService';
import { getGymCatalog } from '../services/pos/posCatalogService';
import {
  mobileRequestOtpSchema,
  mobileVerifyOtpSchema,
  mobileLookupGymsSchema,
  mobileGoogleAuthSchema,
  mobileGoogleSelectSchema,
  mobileGoogleSelectGymSchema,
  mobileDevLoginSchema,
  mobileWorkoutUpsertSchema,
  mobileWorkoutListSchema,
  mobileWorkoutDateParamSchema,
  mobileWorkoutIdParamSchema,
  mobileAnalyticsSchema,
  mobileOrderCreateSchema,
  mobileOrderListSchema,
  mobileOrderIdParamSchema,
  mobileOrderCancelSchema,
  mobileProductsSchema,
  mobileAttendanceSchema,
  mobilePaymentsSchema,
  mobileNotificationsSchema,
  mobileNotificationIdParamSchema,
  mobilePushTokenSchema,
  mobileTrainerMembersSchema,
  mobileTrainerMembersActivitySchema,
  mobileTrainerMemberIdParamSchema,
} from '../validations/mobile';

const router = Router();

function actorFromReq(req: MobileAuthRequest) {
  const u = req.mobileUser!;
  if (u.accountType === 'GUEST' || u.gymId == null) {
    throw new UnauthorizedError('Gym-linked session required');
  }
  return {
    gymId: u.gymId,
    accountType: u.accountType,
    memberId: u.memberId,
    trainerId: u.trainerId,
  };
}

function signMobileToken(payload: {
  gymId?: number | null;
  accountType: 'MEMBER' | 'TRAINER' | 'GUEST';
  memberId?: number;
  trainerId?: number;
  googleUserId?: number;
  name: string;
  phone: string | null;
  email?: string | null;
  tokenVersion: number;
}) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new UnauthorizedError('JWT secret not configured');

  return jwt.sign(
    {
      principal: 'mobile',
      gymId: payload.gymId ?? null,
      accountType: payload.accountType,
      memberId: payload.memberId,
      trainerId: payload.trainerId,
      googleUserId: payload.googleUserId,
      name: payload.name,
      phone: payload.phone,
      email: payload.email ?? null,
      tokenVersion: payload.tokenVersion,
    },
    jwtSecret,
    jwtSignOptions(process.env.MOBILE_JWT_EXPIRES_IN, process.env.JWT_EXPIRES_IN)
  );
}

function issueSessionResponse(
  session:
    | {
        accountType: 'MEMBER' | 'TRAINER';
        tokenVersion: number;
        linked: true;
        profile: { id: number; name: string; phone: string | null; email?: string | null };
        gym: { id: number; name: string; slug: string | null };
      }
    | {
        accountType: 'GUEST';
        tokenVersion: number;
        linked: false;
        profile: { id: number; name: string; phone: null; email: string; photoUrl?: string | null };
        gym: null;
      }
) {
  if (session.accountType === 'GUEST') {
    const token = signMobileToken({
      accountType: 'GUEST',
      googleUserId: session.profile.id,
      name: session.profile.name,
      phone: null,
      email: session.profile.email,
      tokenVersion: session.tokenVersion,
    });
    return {
      token,
      accountType: 'GUEST' as const,
      linked: false as const,
      profile: session.profile,
      gym: null,
    };
  }

  const token = signMobileToken({
    gymId: session.gym.id,
    accountType: session.accountType,
    memberId: session.accountType === 'MEMBER' ? session.profile.id : undefined,
    trainerId: session.accountType === 'TRAINER' ? session.profile.id : undefined,
    name: session.profile.name,
    phone: session.profile.phone,
    email: session.profile.email,
    tokenVersion: session.tokenVersion,
  });
  return {
    token,
    accountType: session.accountType,
    linked: true as const,
    profile: session.profile,
    gym: session.gym,
  };
}

// ─── Public auth ───────────────────────────────────────────────────────────

router.get('/gyms/lookup', validate(mobileLookupGymsSchema), async (req, res: Response) => {
  try {
    const { phone } = req.query as { phone: string };
    const gyms = await lookupGymsByPhone(phone);
    sendSuccess(res, { gyms });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/auth/request-otp', validate(mobileRequestOtpSchema), async (req, res: Response) => {
  try {
    const result = await requestMobileOtp(req.body);
    sendSuccess(res, result, 'OTP sent');
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/auth/verify-otp', validate(mobileVerifyOtpSchema), async (req, res: Response) => {
  try {
    const verified = await verifyMobileOtp(req.body);
    const token = signMobileToken({
      gymId: verified.gym.id,
      accountType: verified.accountType,
      memberId: verified.accountType === 'MEMBER' ? verified.profile.id : undefined,
      trainerId: verified.accountType === 'TRAINER' ? verified.profile.id : undefined,
      name: verified.profile.name,
      phone: verified.profile.phone,
      email: 'email' in verified.profile ? verified.profile.email : null,
      tokenVersion: verified.tokenVersion,
    });
    sendSuccess(res, {
      token,
      profile: verified.profile,
      gym: verified.gym,
      accountType: verified.accountType,
      linked: true,
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/auth/google', validate(mobileGoogleAuthSchema), async (req, res: Response) => {
  try {
    const result = await loginWithGoogleIdToken(req.body.idToken);
    if (result.needsGymSelection) {
      sendSuccess(res, {
        needsGymSelection: true,
        needsAccountSelection: false,
        email: result.email,
        gyms: result.gyms,
      });
      return;
    }
    if (result.needsAccountSelection) {
      sendSuccess(res, {
        needsGymSelection: false,
        needsAccountSelection: true,
        email: result.email,
        accounts: result.accounts,
      });
      return;
    }
    sendSuccess(res, {
      needsGymSelection: false,
      needsAccountSelection: false,
      ...issueSessionResponse(result.session),
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/auth/google/select-gym', validate(mobileGoogleSelectGymSchema), async (req, res: Response) => {
  try {
    const result = await selectGoogleGym(req.body.idToken, req.body.gymId);
    if (result.needsAccountSelection) {
      sendSuccess(res, {
        needsGymSelection: false,
        needsAccountSelection: true,
        email: result.email,
        accounts: result.accounts,
      });
      return;
    }
    if (result.needsGymSelection) {
      sendSuccess(res, {
        needsGymSelection: true,
        needsAccountSelection: false,
        email: result.email,
        gyms: result.gyms,
      });
      return;
    }
    sendSuccess(res, {
      needsGymSelection: false,
      needsAccountSelection: false,
      ...issueSessionResponse(result.session),
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/auth/google/select', validate(mobileGoogleSelectSchema), async (req, res: Response) => {
  try {
    const session = await selectGoogleAccount(
      req.body.idToken,
      req.body.accountType,
      req.body.accountId
    );
    sendSuccess(res, {
      needsGymSelection: false,
      needsAccountSelection: false,
      ...issueSessionResponse(session),
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

// TEMPORARY: email-only sign-in for Expo Go testing. Requires MOBILE_DEV_LOGIN_ENABLED=true.
router.post('/auth/dev-login', validate(mobileDevLoginSchema), async (req, res: Response) => {
  try {
    if (!isDevLoginEnabled()) {
      sendError(res, new UnauthorizedError('Dev login is disabled'));
      return;
    }

    const result = await loginWithDevEmail(req.body.email, {
      gymId: req.body.gymId,
      accountType: req.body.accountType,
      accountId: req.body.accountId,
    });

    if (result.needsGymSelection) {
      sendSuccess(res, {
        needsGymSelection: true,
        needsAccountSelection: false,
        email: result.email,
        gyms: result.gyms,
      });
      return;
    }
    if (result.needsAccountSelection) {
      sendSuccess(res, {
        needsGymSelection: false,
        needsAccountSelection: true,
        email: result.email,
        accounts: result.accounts,
      });
      return;
    }
    sendSuccess(res, {
      needsGymSelection: false,
      needsAccountSelection: false,
      ...issueSessionResponse(result.session),
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.use(authenticateMobileToken);

router.post('/auth/logout', async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    if (u.accountType === 'GUEST' && u.googleUserId) {
      await logoutGoogleGuest(u.googleUserId);
    } else if (u.accountType === 'MEMBER' || u.accountType === 'TRAINER') {
      await logoutMobileUser({
        accountType: u.accountType,
        memberId: u.memberId,
        trainerId: u.trainerId,
      });
    }
    sendSuccess(res, { ok: true }, 'Logged out');
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/me', async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    if (u.accountType === 'MEMBER' && u.memberId && u.gymId != null) {
      await syncPaymentNotifications(u.gymId, u.memberId);
    }
    sendSuccess(res, {
      user: {
        gymId: u.gymId,
        accountType: u.accountType,
        memberId: u.memberId,
        trainerId: u.trainerId,
        googleUserId: u.googleUserId,
        name: u.name,
        phone: u.phone,
        email: u.email ?? null,
        photoUrl: u.photoUrl ?? null,
        linked: u.linked,
      },
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/config/body-parts', (_req, res: Response) => {
  sendSuccess(res, {
    bodyParts: WORKOUT_BODY_PARTS.map((part) => ({
      value: part,
      label: BODY_PART_LABELS[part],
    })),
  });
});

// ─── Workouts ──────────────────────────────────────────────────────────────

router.post('/workouts', validate(mobileWorkoutUpsertSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    if (u.accountType === 'GUEST' && u.googleUserId) {
      const workout = await upsertGuestWorkout(u.googleUserId, req.body);
      sendSuccess(res, { workout }, 'Workout saved', 201);
      return;
    }
    const workout = await upsertWorkout(actorFromReq(req), req.body);
    sendSuccess(res, { workout }, 'Workout saved', 201);
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/workouts', validate(mobileWorkoutListSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    if (u.accountType === 'GUEST' && u.googleUserId) {
      const result = await listGuestWorkouts(u.googleUserId, req.query as any);
      sendSuccess(res, result);
      return;
    }
    const result = await listWorkouts(actorFromReq(req), req.query as any);
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/workouts/:date', validate(mobileWorkoutDateParamSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    const { date } = req.params;
    if (u.accountType === 'GUEST' && u.googleUserId) {
      const workout = await getGuestWorkoutByDate(u.googleUserId, date);
      sendSuccess(res, { workout });
      return;
    }
    const { memberId } = req.query as { memberId?: number };
    const workout = await getWorkoutByDate(actorFromReq(req), date, memberId);
    sendSuccess(res, { workout });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.delete('/workouts/:id', validate(mobileWorkoutIdParamSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    if (u.accountType === 'GUEST' && u.googleUserId) {
      await deleteGuestWorkout(u.googleUserId, Number(req.params.id));
      sendSuccess(res, { ok: true }, 'Workout deleted');
      return;
    }
    await deleteWorkout(actorFromReq(req), Number(req.params.id));
    sendSuccess(res, { ok: true }, 'Workout deleted');
  } catch (error) {
    sendError(res, error as Error);
  }
});

// ─── Analytics ─────────────────────────────────────────────────────────────

router.get('/analytics', validate(mobileAnalyticsSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    if (u.accountType === 'GUEST' && u.googleUserId) {
      const analytics = await getGuestWorkoutAnalytics(u.googleUserId, req.query as any);
      sendSuccess(res, analytics);
      return;
    }
    const analytics = await getCombinedAnalytics(actorFromReq(req), req.query as any);
    sendSuccess(res, analytics);
  } catch (error) {
    sendError(res, error as Error);
  }
});

// ─── Attendance (members + trainer viewing member) ─────────────────────────

router.get('/attendance', requireGymLinked, validate(mobileAttendanceSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    const q = req.query as any;
    let memberId = u.memberId;

    if (u.accountType === 'TRAINER') {
      if (q.memberId) {
        memberId = Number(q.memberId);
        const overview = await getTrainerMemberOverview(u.gymId!, u.trainerId!, memberId);
        memberId = overview.member.id;
      } else {
        sendSuccess(res, {
          records: [],
          summary: { totalRecords: 0, presentDays: 0, note: 'Trainers do not have gym check-in records. View a member\'s attendance instead.' },
          page: 1,
          limit: 30,
          total: 0,
        });
        return;
      }
    }

    if (!memberId) {
      sendError(res, new UnauthorizedError('Member context required'));
      return;
    }

    const result = await getMemberAttendance(u.gymId!, memberId, q);
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error as Error);
  }
});

// ─── Payments (members only) ───────────────────────────────────────────────

router.get('/payments', requireGymLinked, validate(mobilePaymentsSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    const q = req.query as any;
    let memberId = u.memberId;

    if (u.accountType === 'TRAINER' && q.memberId) {
      memberId = Number(q.memberId);
      await assertTrainerMemberAccess(u.gymId!, u.trainerId!, memberId);
    } else if (u.accountType === 'TRAINER') {
      sendSuccess(res, { payments: [], summary: { overdueCount: 0, nextDue: null }, page: 1, limit: 20, total: 0 });
      return;
    }

    if (!memberId) {
      sendError(res, new UnauthorizedError('Member context required'));
      return;
    }

    const result = await getMemberPayments(u.gymId!, memberId, q);
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error as Error);
  }
});

// ─── Products & orders ─────────────────────────────────────────────────────

router.get('/products/catalog', requireGymLinked, async (req: MobileAuthRequest, res: Response) => {
  try {
    const catalog = await getGymCatalog(req.mobileUser!.gymId!, { includeDisabled: false });
    sendSuccess(res, { catalog });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/products', requireGymLinked, validate(mobileProductsSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const q = req.query as any;
    const { products, total } = await listGymProducts(req.mobileUser!.gymId!, {
      productType: q.productType,
      isActive: true,
      search: q.search,
      page: Number(q.page ?? 1),
      limit: Number(q.limit ?? 50),
    });
    sendSuccess(res, {
      products,
      pagination: buildPagination(Number(q.page ?? 1), Number(q.limit ?? 50), total),
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/orders', requireGymLinked, validate(mobileOrderCreateSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const order = await createMobileOrder(actorFromReq(req), req.body);
    sendSuccess(res, { order }, 'Order placed — pay at counter', 201);
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/orders', requireGymLinked, validate(mobileOrderListSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const result = await listMobileOrders(actorFromReq(req), req.query as any);
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/orders/:id', requireGymLinked, validate(mobileOrderIdParamSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const order = await getMobileOrder(actorFromReq(req), Number(req.params.id));
    sendSuccess(res, { order });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/orders/:id/cancel', requireGymLinked, validate(mobileOrderCancelSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const order = await cancelMobileOrder(actorFromReq(req), Number(req.params.id), req.body.reason);
    sendSuccess(res, { order }, 'Order cancelled');
  } catch (error) {
    sendError(res, error as Error);
  }
});

// ─── Notifications ─────────────────────────────────────────────────────────

router.get('/notifications', requireGymLinked, validate(mobileNotificationsSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const q = req.query as any;
    const result = await listNotifications(actorFromReq(req), {
      unreadOnly: q.unreadOnly === 'true',
      page: q.page ? Number(q.page) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/notifications/read-all', requireGymLinked, async (req: MobileAuthRequest, res: Response) => {
  try {
    await markAllNotificationsRead(actorFromReq(req));
    sendSuccess(res, { ok: true });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/notifications/:id/read', requireGymLinked, validate(mobileNotificationIdParamSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    await markNotificationRead(actorFromReq(req), Number(req.params.id));
    sendSuccess(res, { ok: true });
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.post('/push-token', requireGymLinked, validate(mobilePushTokenSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    await registerPushToken(actorFromReq(req), req.body);
    sendSuccess(res, { ok: true });
  } catch (error) {
    sendError(res, error as Error);
  }
});

// ─── Trainer: members ──────────────────────────────────────────────────────

router.get(
  '/trainer/members/activity',
  requireGymLinked,
  requireTrainer,
  validate(mobileTrainerMembersActivitySchema),
  async (req: MobileAuthRequest, res: Response) => {
    try {
      const u = req.mobileUser!;
      const date = (req.query as { date?: string }).date;
      const result = await getTrainerMembersDailyActivity(u.gymId!, u.trainerId!, date);
      sendSuccess(res, result);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get('/trainer/members', requireGymLinked, requireTrainer, validate(mobileTrainerMembersSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    const result = await listTrainerMembers(u.gymId!, u.trainerId!, req.query as any);
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.get('/trainer/members/:memberId', requireGymLinked, requireTrainer, validate(mobileTrainerMemberIdParamSchema), async (req: MobileAuthRequest, res: Response) => {
  try {
    const u = req.mobileUser!;
    const overview = await getTrainerMemberOverview(u.gymId!, u.trainerId!, Number(req.params.memberId));
    sendSuccess(res, overview);
  } catch (error) {
    sendError(res, error as Error);
  }
});

export default router;
