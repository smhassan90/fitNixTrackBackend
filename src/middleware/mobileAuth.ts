import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { MobileAccountType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { sendError } from '../utils/response';

export type MobileSessionAccountType = MobileAccountType | 'GUEST';

export interface MobileAuthRequest extends Request {
  mobileUser?: {
    gymId: number | null;
    accountType: MobileSessionAccountType;
    memberId?: number;
    trainerId?: number;
    googleUserId?: number;
    name: string;
    phone: string | null;
    email?: string | null;
    linked: boolean;
  };
}

type MobileJwtPayload = {
  principal?: string;
  gymId?: number | null;
  accountType?: MobileSessionAccountType;
  memberId?: number;
  trainerId?: number;
  googleUserId?: number;
  name?: string;
  phone?: string | null;
  email?: string | null;
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

      if (!decoded.accountType) {
        sendError(res, new UnauthorizedError('Invalid token'));
        return;
      }

      if (decoded.accountType === 'GUEST') {
        if (!decoded.googleUserId) {
          sendError(res, new UnauthorizedError('Invalid token'));
          return;
        }
        const guest = await prisma.mobileGoogleUser.findUnique({
          where: { id: decoded.googleUserId },
          select: {
            id: true,
            name: true,
            email: true,
            tokenVersion: true,
          },
        });
        if (!guest) {
          sendError(res, new UnauthorizedError('Invalid guest session'));
          return;
        }
        if (
          decoded.tokenVersion !== undefined &&
          decoded.tokenVersion !== guest.tokenVersion
        ) {
          sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
          return;
        }
        req.mobileUser = {
          gymId: null,
          accountType: 'GUEST',
          googleUserId: guest.id,
          name: guest.name,
          phone: null,
          email: guest.email,
          linked: false,
        };
        next();
        return;
      }

      if (!decoded.gymId) {
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
            email: true,
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
          email: member.email,
          linked: true,
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
            email: true,
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
          email: trainer.email ?? decoded.email ?? null,
          linked: true,
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

export function requireGymLinked(req: MobileAuthRequest, res: Response, next: NextFunction): void {
  if (!req.mobileUser) {
    sendError(res, new UnauthorizedError('Authentication required'));
    return;
  }
  if (req.mobileUser.accountType === 'GUEST' || !req.mobileUser.linked) {
    sendError(
      res,
      new ForbiddenError(
        'This feature is available only for gym members linked by Gmail on their profile.'
      )
    );
    return;
  }
  next();
}
