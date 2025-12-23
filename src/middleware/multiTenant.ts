import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { UnauthorizedError } from '../utils/errors';
import { sendError } from '../utils/response';

/**
 * Middleware to ensure gymId is present in request
 * This should be used after authenticateToken middleware
 */
export function requireGymId(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || !req.user.gymId) {
    sendError(res, new UnauthorizedError('Gym ID not found in token'));
    return;
  }

  // Add gymId to request for easy access
  req.gymId = req.user.gymId;
  next();
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      gymId?: string;
    }
  }
}

