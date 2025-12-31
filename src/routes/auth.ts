import { Router, Response } from 'express';
// import bcrypt from 'bcrypt'; // TEMPORARILY DISABLED - using plain text passwords for development
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { loginSchema, meSchema } from '../validations/auth';
import { sendSuccess, sendError } from '../utils/response';
import { UnauthorizedError, NotFoundError } from '../utils/errors';

const router = Router();

// POST /api/auth/login
router.post(
  '/login',
  validate(loginSchema),
  async (req, res: Response) => {
    try {
      const { email, password } = req.body;

      // Normalize email (lowercase, trim) and password (trim)
      const normalizedEmail = email?.toLowerCase().trim();
      const normalizedPassword = password?.trim();

      if (!normalizedEmail || !normalizedPassword) {
        sendError(res, new UnauthorizedError('Email and password are required'));
        return;
      }

      // Find user (email is already normalized to lowercase)
      let user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { gym: true },
      });

      // Fallback: If not found, search all users and match case-insensitively
      // This handles cases where email in DB has different casing
      if (!user) {
        const allUsers = await prisma.user.findMany({
          include: { gym: true },
        });
        user = allUsers.find(u => u.email.toLowerCase().trim() === normalizedEmail) || null;
      }

      if (!user) {
        sendError(res, new UnauthorizedError('Invalid email or password'));
        return;
      }

      // Verify password - trim both for comparison
      // TEMPORARY: Using plain text comparison for development
      // TODO: Re-enable bcrypt hashing before production
      // const isValidPassword = await bcrypt.compare(normalizedPassword, user.password);
      const userPassword = user.password?.trim() || '';
      const isValidPassword = normalizedPassword === userPassword;
      
      if (!isValidPassword) {
        sendError(res, new UnauthorizedError('Invalid email or password'));
        return;
      }

      // Generate JWT token
      const jwtSecret = process.env.JWT_SECRET;
      const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';

      if (!jwtSecret) {
        sendError(res, new UnauthorizedError('JWT secret not configured'));
        return;
      }

      const payload = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        gymId: user.gymId,
        gymName: user.gym?.name,
      };

      const token = jwt.sign(payload, jwtSecret, {
        expiresIn: jwtExpiresIn,
      } as jwt.SignOptions);

      // Return user data (without password) and token
      const { password: _, ...userWithoutPassword } = user;
      sendSuccess(
        res,
        {
          user: {
            ...userWithoutPassword,
            gymName: user.gym?.name,
          },
          token,
        },
        'Login successful',
        200
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/auth/me
router.get(
  '/me',
  authenticateToken,
  validate(meSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        sendError(res, new UnauthorizedError('User not found'));
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          gymId: true,
          gymName: true,
          createdAt: true,
          updatedAt: true,
          gym: {
            select: {
              id: true,
              name: true,
              address: true,
              phone: true,
              email: true,
            },
          },
        },
      });

      if (!user) {
        sendError(res, new NotFoundError('User'));
        return;
      }

      sendSuccess(res, {
        ...user,
        gymName: user.gym?.name || user.gymName,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/auth/logout (optional, client-side token removal)
router.post('/logout', authenticateToken, (req: AuthRequest, res: Response) => {
  // Since we're using stateless JWT, logout is handled client-side
  // This endpoint just confirms the request
  sendSuccess(res, { message: 'Logged out successfully' });
});

export default router;

