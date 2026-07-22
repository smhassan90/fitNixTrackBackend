import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { MobileAccountType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { sendError } from '../utils/response';

export interface MobileAuthRequest extends Request {
  mobileUser?: {
    gymId: number;
    accountType: MobileAccountType;
    memberId?: number;
    trainerId?: number;
    name: string;
    phone: string | null;
  };
}

type MobileJwtPayload = {
  principal?: string;
  gymId?: number;
  accountType?: MobileAccountType;
  memberId?: number;
  trainerId?: number;
  name?: string;
  phone?: string | null;
  tokenVersion?: number;
};

export function authenticateMobileToken(
  req: MobileAuthRequest,
  res: Response,
  next: NextFunction
): void {
  void (async () => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      sendError(res, new UnauthorizedError('No token provided'));
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      sendError(res, new UnauthorizedError('JWT secret not configured'));
      return;
    }

    try {
      const decoded = jwt.verify(token, jwtSecret) as MobileJwtPayload;

      if (decoded.principal !== 'mobile') {
        sendError(res, new UnauthorizedError('Invalid mobile session token'));
        return;
      }

      if (!decoded.gymId || !decoded.accountType) {
        sendError(res, new UnauthorizedError('Invalid token'));
        return;
      }

      const gym = await prisma.gym.findUnique({
        where: { id: decoded.gymId },
        select: { tenantStatus: true },
      });

      if (!gym || gym.tenantStatus === 'SUSPENDED') {
        sendError(res, new ForbiddenError('This gym account is suspended.'));
        return;
      }

      if (decoded.accountType === 'MEMBER') {
        if (!decoded.memberId) {
          sendError(res, new UnauthorizedError('Invalid token'));
          return;
        }
        const member = await prisma.member.findFirst({
          where: { id: decoded.memberId, gymId: decoded.gymId },
          select: {
            id: true,
            name: true,
            phone: true,
            isActive: true,
            mobileTokenVersion: true,
          },
        });
        if (!member || !member.isActive) {
          sendError(res, new ForbiddenError('Member account is inactive.'));
          return;
        }
        if (
          decoded.tokenVersion !== undefined &&
          decoded.tokenVersion !== member.mobileTokenVersion
        ) {
          sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
          return;
        }
        req.mobileUser = {
          gymId: decoded.gymId,
          accountType: 'MEMBER',
          memberId: member.id,
          name: member.name,
          phone: member.phone,
        };
      } else {
        if (!decoded.trainerId) {
          sendError(res, new UnauthorizedError('Invalid token'));
          return;
        }
        const trainer = await prisma.trainer.findFirst({
          where: { id: decoded.trainerId, gymId: decoded.gymId },
          select: {
            id: true,
            name: true,
            phone: true,
            isActive: true,
            mobileTokenVersion: true,
          },
        });
        if (!trainer || !trainer.isActive) {
          sendError(res, new ForbiddenError('Trainer account is inactive.'));
          return;
        }
        if (
          decoded.tokenVersion !== undefined &&
          decoded.tokenVersion !== trainer.mobileTokenVersion
        ) {
          sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
          return;
        }
        req.mobileUser = {
          gymId: decoded.gymId,
          accountType: 'TRAINER',
          trainerId: trainer.id,
          name: trainer.name,
          phone: trainer.phone,
        };
      }

      next();
    } catch {
      sendError(res, new UnauthorizedError('Invalid or expired token'));
    }
  })();
}

export function requireTrainer(req: MobileAuthRequest, res: Response, next: NextFunction): void {
  if (!req.mobileUser) {
    sendError(res, new UnauthorizedError('Authentication required'));
    return;
  }
  if (req.mobileUser.accountType !== 'TRAINER') {
    sendError(res, new ForbiddenError('Trainer access required'));
    return;
  }
  next();
}
