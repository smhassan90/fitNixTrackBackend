import { Router, Response } from 'express';
import {
  authenticateMobileToken,
  MobileAuthRequest,
  requireGymLinked,
} from '../middleware/mobileAuth';
import { validate } from '../middleware/validation';
import { mobileDeleteAccountSchema } from '../validations/accountDeletion';
import { createAccountDeletionRequest } from '../services/accountDeletionService';
import { logoutMobileUser } from '../services/mobileOtpService';
import { logoutGoogleGuest } from '../services/mobileGoogleAuthService';
import { sendSuccess, sendError } from '../utils/response';
import { UnauthorizedError } from '../utils/errors';
import { prisma } from '../lib/prisma';

const router = Router();

router.use(authenticateMobileToken);

/**
 * Authenticated in-app deletion request.
 * POST /api/me/delete-account
 * Bearer mobile JWT (MEMBER | TRAINER | GUEST)
 */
router.post(
  '/delete-account',
  validate(mobileDeleteAccountSchema),
  async (req: MobileAuthRequest, res: Response) => {
    try {
      const u = req.mobileUser!;
      const reason =
        req.body?.reason != null && String(req.body.reason).trim()
          ? String(req.body.reason).trim()
          : null;

      let fullName = u.name || 'App user';
      let email = u.email ?? null;
      let phone = u.phone ?? null;
      let accountType: 'member' | 'trainer' | 'other' = 'other';
      let gymName: string | null = null;
      let matchedMemberId: number | null = null;
      let matchedTrainerId: number | null = null;
      let matchedGymId: number | null = u.gymId;

      if (u.accountType === 'MEMBER' && u.memberId) {
        accountType = 'member';
        matchedMemberId = u.memberId;
        const member = await prisma.member.findUnique({
          where: { id: u.memberId },
          select: {
            name: true,
            email: true,
            phone: true,
            gym: { select: { name: true } },
          },
        });
        if (member) {
          fullName = member.name;
          email = member.email ?? email;
          phone = member.phone ?? phone;
          gymName = member.gym.name;
        }
      } else if (u.accountType === 'TRAINER' && u.trainerId) {
        accountType = 'trainer';
        matchedTrainerId = u.trainerId;
        const trainer = await prisma.trainer.findUnique({
          where: { id: u.trainerId },
          select: {
            name: true,
            email: true,
            phone: true,
            gym: { select: { name: true } },
          },
        });
        if (trainer) {
          fullName = trainer.name;
          email = trainer.email ?? email;
          phone = trainer.phone ?? phone;
          gymName = trainer.gym.name;
        }
      } else if (u.accountType === 'GUEST' && u.googleUserId) {
        accountType = 'other';
        const guest = await prisma.mobileGoogleUser.findUnique({
          where: { id: u.googleUserId },
          select: { name: true, email: true },
        });
        if (guest) {
          fullName = guest.name;
          email = guest.email;
        }
      }

      if (!email && !phone) {
        throw new UnauthorizedError(
          'Your session has no email or phone on file. Use the web form at /account-deletion instead.'
        );
      }

      const result = await createAccountDeletionRequest({
        fullName,
        email,
        phone,
        accountType,
        gymName,
        reason,
        source: 'app',
        matchedMemberId,
        matchedTrainerId,
        matchedGymId,
        requesterIp:
          typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for'].split(',')[0].trim()
            : req.ip ?? null,
      });

      // Invalidate current session immediately (request still pending for full anonymize).
      if (u.accountType === 'GUEST' && u.googleUserId) {
        await logoutGoogleGuest(u.googleUserId);
      } else if (u.accountType === 'MEMBER' || u.accountType === 'TRAINER') {
        await logoutMobileUser({
          accountType: u.accountType,
          memberId: u.memberId,
          trainerId: u.trainerId,
        });
      }

      sendSuccess(
        res,
        {
          ...result,
          loggedOut: true,
        },
        undefined,
        201
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// Keep requireGymLinked available if we add gym-linked-only me routes later.
void requireGymLinked;

export default router;
