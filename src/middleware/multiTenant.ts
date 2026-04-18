import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { UnauthorizedError } from '../utils/errors';
import { sendError } from '../utils/response';

/**
 * Gym scope: requires authenticated gym user with numeric gymId (set by authenticateToken from DB).
 * Suspended gyms are rejected in authenticateToken before reaching here.
 */
export function requireGymId(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user?.gymId) {
    sendError(res, new UnauthorizedError('Gym ID not found in token'));
    return;
  }

  const gymId =
    typeof req.user.gymId === 'string' ? parseInt(req.user.gymId, 10) : req.user.gymId;

  if (isNaN(gymId)) {
    sendError(
      res,
      new UnauthorizedError('Your session token is outdated. Please log in again.')
    );
    return;
  }

  req.gymId = gymId;
  next();
}

// Extend Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      gymId?: number;
    }
  }
}

