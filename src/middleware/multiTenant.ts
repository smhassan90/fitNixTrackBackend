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

  // After migration, gymId should always be a number
  // If it's still a string (old token with CUID), user needs to re-login
  const gymId = typeof req.user.gymId === 'string' 
    ? parseInt(req.user.gymId, 10) 
    : req.user.gymId;
  
  if (isNaN(gymId)) {
    // This means the token has a CUID string that can't be parsed as integer
    // User needs to re-login after the database migration
    sendError(res, new UnauthorizedError('Your session token is outdated. Please log in again after the database migration.'));
    return;
  }

  // Add gymId to request for easy access
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

