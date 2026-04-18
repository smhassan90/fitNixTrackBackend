import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { sendError } from '../utils/response';
import type { PlatformRole } from '@prisma/client';

export type PlatformRequest = Request & {
  platformUser?: {
    id: number;
    email: string;
    name: string;
    role: PlatformRole;
    tokenVersion: number;
  };
};

function isPlatformJwtPayload(
  decoded: jwt.JwtPayload | string
): decoded is jwt.JwtPayload & {
  principal: string;
  platformUserId: number;
  tokenVersion?: number;
} {
  if (typeof decoded !== 'object' || decoded === null) return false;
  const d = decoded as Record<string, unknown>;
  return d.principal === 'platform' && d.platformUserId !== undefined && d.platformUserId !== null;
}

export function authenticatePlatformToken(
  req: PlatformRequest,
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
      const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload;
      if (!isPlatformJwtPayload(decoded)) {
        sendError(res, new ForbiddenError('Invalid platform session'));
        return;
      }

      const platformUserId = Number(decoded.platformUserId);
      if (!Number.isFinite(platformUserId)) {
        sendError(res, new UnauthorizedError('Invalid platform token'));
        return;
      }

      const user = await prisma.platformUser.findUnique({
        where: { id: platformUserId },
        select: { id: true, email: true, name: true, role: true, tokenVersion: true },
      });

      if (!user) {
        sendError(res, new UnauthorizedError('Platform user not found'));
        return;
      }

      const tv = decoded.tokenVersion;
      if (tv !== undefined && tv !== user.tokenVersion) {
        sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
        return;
      }

      req.platformUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tokenVersion: user.tokenVersion,
      };
      next();
    } catch {
      sendError(res, new UnauthorizedError('Invalid or expired token'));
    }
  })();
}

export function requirePlatformRole(...allowed: PlatformRole[]) {
  return (req: PlatformRequest, res: Response, next: NextFunction): void => {
    if (!req.platformUser) {
      sendError(res, new UnauthorizedError('Authentication required'));
      return;
    }
    if (!allowed.includes(req.platformUser.role)) {
      sendError(res, new ForbiddenError('Insufficient platform permissions'));
      return;
    }
    next();
  };
}
