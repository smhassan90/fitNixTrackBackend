import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { sendError } from '../utils/response';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    name: string;
    role: string;
    gymId: number;
    gymName?: string;
  };
}

type GymJwtPayload = {
  principal?: string;
  id?: number | string;
  email?: string;
  name?: string;
  role?: string;
  gymId?: number | string;
  gymName?: string;
  tokenVersion?: number;
};

export function authenticateToken(
  req: AuthRequest,
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
      const decoded = jwt.verify(token, jwtSecret) as GymJwtPayload;

      if (decoded.principal === 'platform') {
        sendError(
          res,
          new ForbiddenError('This token is for platform admin. Use gym credentials for this API.')
        );
        return;
      }

      let userId: number;
      if (typeof decoded.id === 'string') {
        const parsed = parseInt(decoded.id, 10);
        if (isNaN(parsed)) {
          sendError(
            res,
            new UnauthorizedError(
              'Your session token contains an old user ID format. Please log in again.'
            )
          );
          return;
        }
        userId = parsed;
      } else if (typeof decoded.id === 'number') {
        userId = decoded.id;
      } else {
        sendError(res, new UnauthorizedError('Invalid token'));
        return;
      }

      const dbUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          gymId: true,
          isActive: true,
          tokenVersion: true,
          gym: { select: { name: true, tenantStatus: true } },
        },
      });

      if (!dbUser || !dbUser.gym) {
        sendError(res, new UnauthorizedError('User not found'));
        return;
      }

      if (dbUser.isActive === false) {
        sendError(res, new ForbiddenError('This account is deactivated. Contact a gym administrator.'));
        return;
      }

      if (dbUser.gym.tenantStatus === 'SUSPENDED') {
        sendError(
          res,
          new ForbiddenError('This gym account is suspended. Contact your administrator.')
        );
        return;
      }

      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== dbUser.tokenVersion) {
        sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
        return;
      }

      req.user = {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role,
        gymId: dbUser.gymId,
        gymName: dbUser.gym.name ?? undefined,
      };

      next();
    } catch {
      sendError(res, new UnauthorizedError('Invalid or expired token'));
    }
  })();
}

export function requireRole(...allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, new UnauthorizedError('Authentication required'));
      return;
    }

    const userRole = req.user.role;
    if (!userRole) {
      sendError(res, new ForbiddenError('Unauthorized. Admin access required.'));
      return;
    }

    const normalizedUserRole = String(userRole).toUpperCase();
    const normalizedAllowedRoles = allowedRoles.map((r) => String(r).toUpperCase());

    if (!normalizedAllowedRoles.includes(normalizedUserRole)) {
      sendError(res, new ForbiddenError('Unauthorized. Admin access required.'));
      return;
    }

    next();
  };
}
