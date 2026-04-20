import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { loginSchema, meSchema } from '../validations/auth';
import { sendSuccess, sendError } from '../utils/response';
import { UnauthorizedError, NotFoundError, ForbiddenError } from '../utils/errors';

const router = Router();

// POST /api/auth/login
router.post(
  '/login',
  validate(loginSchema),
  async (req, res: Response) => {
    try {
      const { email, password } = req.body;

      const normalizedEmail = email?.toLowerCase().trim();
      const normalizedPassword = password?.trim();

      if (!normalizedEmail || !normalizedPassword) {
        sendError(res, new UnauthorizedError('Email and password are required'));
        return;
      }

      let user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { gym: true },
      });

      if (!user) {
        const allUsers = await prisma.user.findMany({
          include: { gym: true },
        });
        user = allUsers.find((u) => u.email.toLowerCase().trim() === normalizedEmail) || null;
      }

      if (!user) {
        sendError(res, new UnauthorizedError('Invalid email or password'));
        return;
      }

      if (user.gym.tenantStatus === 'SUSPENDED') {
        sendError(
          res,
          new ForbiddenError('This gym account is suspended. Contact your administrator.')
        );
        return;
      }

      const userPassword = user.password?.trim() || '';
      const isBcrypt = userPassword.startsWith('$2');
      const isValidPassword = isBcrypt
        ? await bcrypt.compare(normalizedPassword, userPassword)
        : normalizedPassword === userPassword;

      if (!isValidPassword) {
        sendError(res, new UnauthorizedError('Invalid email or password'));
        return;
      }

      const jwtSecret = process.env.JWT_SECRET;
      const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';

      if (!jwtSecret) {
        sendError(res, new UnauthorizedError('JWT secret not configured'));
        return;
      }

      const payload = {
        principal: 'gym',
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        gymId: user.gymId,
        gymName: user.gym?.name,
        tokenVersion: user.tokenVersion,
      };

      const token = jwt.sign(payload, jwtSecret, {
        expiresIn: jwtExpiresIn,
      } as jwt.SignOptions);

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
              tenantStatus: true,
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

// POST /api/auth/logout — bump tokenVersion to invalidate outstanding JWTs
router.post('/logout', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      sendError(res, new UnauthorizedError('User not found'));
      return;
    }
    await prisma.user.update({
      where: { id: req.user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    sendSuccess(res, { ok: true }, 'Logged out successfully');
  } catch (error) {
    sendError(res, error as Error);
  }
});

export default router;
