import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PlatformRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import {
  authenticatePlatformToken,
  requirePlatformRole,
  PlatformRequest,
} from '../../middleware/platformAuth';
import { platformLoginRateLimiter } from '../../middleware/platformLoginRateLimit';
import { platformLoginSchema } from '../../validations/platform';
import { sendSuccess, sendError } from '../../utils/response';
import { UnauthorizedError } from '../../utils/errors';
import {
  assertPlatformLoginAllowed,
  clearPlatformLoginFailures,
  getClientIp,
  recordPlatformLoginFailure,
} from '../../services/platformLoginGuard';
import { writePlatformAuditLog } from '../../services/platformAuditService';
import { platformJwtSignOptions } from '../../utils/jwtExpiresIn';

const router = Router();

router.post(
  '/login',
  platformLoginRateLimiter,
  validate(platformLoginSchema),
  async (req: PlatformRequest, res: Response) => {
    const ip = getClientIp(req);
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '').trim();

    try {
      assertPlatformLoginAllowed(ip, email);
    } catch (e: unknown) {
      const err = e as Error & { statusCode?: number; code?: string };
      if (err.statusCode === 429) {
        return res.status(429).json({
          success: false,
          error: { code: err.code || 'RATE_LIMITED', message: err.message },
        });
      }
      throw e;
    }

    try {
      const user = await prisma.platformUser.findUnique({
        where: { email },
      });

      if (!user) {
        recordPlatformLoginFailure(ip, email);
        sendError(res, new UnauthorizedError('Invalid email or password'));
        return;
      }

      if (!user.isActive) {
        recordPlatformLoginFailure(ip, email);
        sendError(res, new UnauthorizedError('Invalid email or password'));
        return;
      }

      const ok = await bcrypt.compare(password, user.password);
      if (!ok) {
        recordPlatformLoginFailure(ip, email);
        sendError(res, new UnauthorizedError('Invalid email or password'));
        return;
      }

      clearPlatformLoginFailures(ip, email);

      await prisma.platformUser.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        sendError(res, new UnauthorizedError('JWT secret not configured'));
        return;
      }

      const token = jwt.sign(
        {
          principal: 'platform',
          platformUserId: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tokenVersion: user.tokenVersion,
        },
        jwtSecret,
        platformJwtSignOptions()
      );

      await writePlatformAuditLog({
        actorUserId: user.id,
        actorRole: user.role,
        actionType: 'PLATFORM_LOGIN',
        metadata: { ip },
      });

      sendSuccess(
        res,
        {
          token,
          user: { id: user.id, role: user.role, email: user.email, name: user.name },
        },
        'Login successful'
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/logout',
  authenticatePlatformToken,
  requirePlatformRole(PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT),
  async (req: PlatformRequest, res: Response) => {
    try {
      const pu = req.platformUser!;
      await prisma.platformUser.update({
        where: { id: pu.id },
        data: { tokenVersion: { increment: 1 } },
      });
      await writePlatformAuditLog({
        actorUserId: pu.id,
        actorRole: pu.role,
        actionType: 'PLATFORM_LOGOUT',
      });
      sendSuccess(res, { ok: true }, 'Logged out');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/me',
  authenticatePlatformToken,
  requirePlatformRole(PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT),
  async (req: PlatformRequest, res: Response) => {
    try {
      const pu = req.platformUser!;
      sendSuccess(res, {
        id: pu.id,
        email: pu.email,
        name: pu.name,
        role: pu.role,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
