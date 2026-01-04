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
    
    // Explicitly construct user object to ensure all fields are set correctly
    req.user = {
      id: userId,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role || 'STAFF', // Default to STAFF if role is missing
      gymId: gymId,
      gymName: decoded.gymName,
    };
    
    // Debug logging - always log to help debug Vercel issues
    console.log('[authenticateToken] User authenticated:', {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      roleType: typeof req.user.role,
      gymId: req.user.gymId
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
      console.error('[requireRole] No user found in request');
      sendError(res, new UnauthorizedError('Authentication required'));
      return;
    }

    const userRole = req.user.role;
    
    // Always log for debugging (can be removed later)
    console.log('[requireRole] Checking access:', {
      userRole: userRole,
      userRoleType: typeof userRole,
      allowedRoles: allowedRoles,
      userEmail: req.user.email,
      userId: req.user.id
    });
    
    // Check if user role matches any of the allowed roles
    if (!userRole) {
      console.error('[requireRole] No role found for user:', req.user.email);
      sendError(res, new ForbiddenError('Unauthorized. Admin access required.'));
      return;
    }
    
    // Normalize role to uppercase for comparison (in case of case sensitivity issues)
    const normalizedUserRole = String(userRole).toUpperCase();
    const normalizedAllowedRoles = allowedRoles.map(r => String(r).toUpperCase());
    
    if (!normalizedAllowedRoles.includes(normalizedUserRole)) {
      console.error('[requireRole] Access denied:', {
        userRole: userRole,
        normalizedUserRole: normalizedUserRole,
        allowedRoles: allowedRoles,
        normalizedAllowedRoles: normalizedAllowedRoles
      });
      sendError(res, new ForbiddenError('Unauthorized. Admin access required.'));
      return;
    }

    console.log('[requireRole] Access granted for role:', userRole);
    next();
  };
}

