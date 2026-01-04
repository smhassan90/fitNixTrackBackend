import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
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

export function authenticateToken(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

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
    const decoded = jwt.verify(token, jwtSecret) as {
      id: number | string; // Can be string (old tokens) or number (new tokens)
      email: string;
      name: string;
      role: string;
      gymId: number | string; // Can be string (old tokens) or number (new tokens)
      gymName?: string;
    };
    
    // Convert IDs to numbers if they're strings (for backward compatibility with old tokens)
    let userId: number;
    let gymId: number;
    
    // Convert user ID
    if (typeof decoded.id === 'string') {
      const parsed = parseInt(decoded.id, 10);
      if (isNaN(parsed)) {
        sendError(res, new UnauthorizedError(
          'Your session token contains an old user ID format. ' +
          'Please ensure the database migration has been run, then log in again to get a new token.'
        ));
        return;
      }
      userId = parsed;
    } else {
      userId = decoded.id;
    }
    
    // Convert gym ID
    if (typeof decoded.gymId === 'string') {
      const parsed = parseInt(decoded.gymId, 10);
      if (isNaN(parsed)) {
        sendError(res, new UnauthorizedError(
          'Your session token contains an old gym ID format. ' +
          'Please ensure the database migration has been run, then log in again to get a new token.'
        ));
        return;
      }
      gymId = parsed;
    } else {
      gymId = decoded.gymId;
    }
    
    req.user = {
      ...decoded,
      id: userId, // Ensure it's always a number
      gymId, // Ensure it's always a number
      role: decoded.role, // Ensure role is explicitly set
    };
    
    // Debug logging
    console.log('[authenticateToken] User authenticated:', {
      id: userId,
      email: decoded.email,
      role: decoded.role,
      gymId: gymId
    });
    
    next();
  } catch (error) {
    sendError(res, new UnauthorizedError('Invalid or expired token'));
  }
}

/**
 * Middleware to ensure user has required role
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, new UnauthorizedError('Authentication required'));
      return;
    }

    const userRole = req.user.role;
    
    // Debug logging (only in development)
    if (process.env.NODE_ENV === 'development') {
      console.log('[requireRole] User role:', userRole, 'Type:', typeof userRole);
      console.log('[requireRole] Allowed roles:', allowedRoles);
      console.log('[requireRole] Match:', allowedRoles.includes(userRole));
    }
    
    // Check if user role matches any of the allowed roles
    if (!userRole || !allowedRoles.includes(userRole)) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[requireRole] Access denied - User role:', userRole, 'not in allowed roles:', allowedRoles);
      }
      sendError(res, new ForbiddenError('Unauthorized. Admin access required.'));
      return;
    }

    next();
  };
}

