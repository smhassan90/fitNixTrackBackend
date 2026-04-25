import { randomBytes } from 'crypto';
import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest, requireRole } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { sendSuccess, sendError } from '../utils/response';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  gymUserIdParamSchema,
  gymUserCreateSchema,
  gymUserPatchSchema,
} from '../validations/gymUsers';

const router = Router();
const BCRYPT_ROUNDS = 10;
function assertXGymIdMatchesSession(req: AuthRequest): void {
  const h = req.headers['x-gym-id'] ?? (req.headers as any)['X-Gym-Id'];
  if (h === undefined || h === null || h === '') return;
  const expected = String(req.user!.gymId);
  if (String(h).trim() !== expected) {
    throw new ForbiddenError('X-Gym-Id does not match your session');
  }
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Count active GYM_ADMIN users in gym (optionally excluding a user id from the count).
 */
async function countActiveAdmins(gymId: number, excludeUserId?: number): Promise<number> {
  return prisma.user.count({
    where: {
      gymId,
      isActive: true,
      role: 'GYM_ADMIN',
      ...(excludeUserId != null ? { id: { not: excludeUserId } } : {}),
    },
  });
}

/**
 * If applied, there must remain at least one active GYM_ADMIN in the gym.
 */
async function assertAtLeastOneActiveAdmin(
  gymId: number,
  targetId: number,
  next: {
    isActive: boolean;
    role: UserRole;
  }
): Promise<void> {
  const willBeActiveAdmin = next.isActive && next.role === 'GYM_ADMIN';
  if (willBeActiveAdmin) return;

  const otherAdmins = await countActiveAdmins(gymId, targetId);
  if (otherAdmins < 1) {
    throw new ForbiddenError('The gym must have at least one active administrator');
  }
}

router.use(authenticateToken, requireGymId);

router.get('/users', requireRole('GYM_ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    assertXGymIdMatchesSession(req);
    const gymId = req.gymId!;
    const list = await prisma.user.findMany({
      where: { gymId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    sendSuccess(res, { users: list });
  } catch (e) {
    sendError(res, e as Error);
  }
});

router.post(
  '/users',
  requireRole('GYM_ADMIN'),
  validate(gymUserCreateSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      assertXGymIdMatchesSession(req);
      const gymId = req.gymId!;
      const { name, email, phone, role, password: rawPassword } = req.body;
      const norm = normalizeEmail(email);
      const dup = await prisma.user.findUnique({
        where: { gymId_email: { gymId, email: norm } },
      });
      if (dup) {
        sendError(res, new ConflictError('A user with this email already exists in your gym'));
        return;
      }

      const tempPassword = rawPassword
        ? rawPassword
        : randomBytes(16).toString('base64url') + 'Aa1!';

      const passwordHash = await bcrypt.hash((rawPassword || tempPassword).trim(), BCRYPT_ROUNDS);

      const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { name: true } });
      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const user = await prisma.user.create({
        data: {
          name: name.trim(),
          email: norm,
          phone: phone && String(phone).trim() ? String(phone).trim() : null,
          role,
          password: passwordHash,
          gymId,
          gymName: gym.name,
          isActive: true,
          tokenVersion: 0,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
          lastLoginAt: true,
        },
      });

      const payload: { user: typeof user; temporaryPassword?: string } = { user };
      if (!rawPassword) {
        payload.temporaryPassword = tempPassword;
      }

      sendSuccess(res, payload, 'User created', 201);
    } catch (e) {
      sendError(res, e as Error);
    }
  }
);

router.patch(
  '/users/:id',
  requireRole('GYM_ADMIN'),
  validate(gymUserPatchSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      assertXGymIdMatchesSession(req);
      const gymId = req.gymId!;
      const memberId = Number(req.params.id);
      const body = req.body;
      const caller = req.user!;

      const existing = await prisma.user.findFirst({ where: { id: memberId, gymId } });
      if (!existing) {
        sendError(res, new NotFoundError('User', memberId));
        return;
      }

      if (body.email !== undefined) {
        const norm = normalizeEmail(String(body.email));
        const other = await prisma.user.findFirst({
          where: { gymId, email: norm, NOT: { id: memberId } },
        });
        if (other) {
          sendError(res, new ConflictError('A user with this email already exists in your gym'));
          return;
        }
      }

      const nextIsActive = body.isActive !== undefined ? body.isActive : existing.isActive;
      const nextRole: UserRole = (body.role as UserRole | undefined) ?? existing.role;

      if (memberId === caller.id) {
        if (body.isActive === false) {
          sendError(res, new ForbiddenError('You cannot deactivate your own account'));
          return;
        }
        if (body.role && body.role !== 'GYM_ADMIN' && existing.role === 'GYM_ADMIN') {
          const otherAdmins = await countActiveAdmins(gymId, memberId);
          if (otherAdmins < 1) {
            sendError(res, new ForbiddenError('You cannot remove the last admin role from yourself'));
            return;
          }
        }
      } else {
        // Changing someone else: ensure at least one active admin remains
        await assertAtLeastOneActiveAdmin(gymId, memberId, {
          isActive: nextIsActive,
          role: nextRole,
        });
      }

      const data: {
        name?: string;
        email?: string;
        phone?: string | null;
        role?: UserRole;
        isActive?: boolean;
        password?: string;
        tokenVersion?: { increment: number };
        gymName?: string;
      } = {};

      if (body.name !== undefined) data.name = body.name.trim();
      if (body.email !== undefined) data.email = normalizeEmail(String(body.email));
      if (body.phone !== undefined) {
        data.phone = body.phone && String(body.phone).trim() ? String(body.phone).trim() : null;
      }
      if (body.role !== undefined) data.role = body.role;
      if (body.isActive !== undefined) data.isActive = body.isActive;

      if (body.password != null && String(body.password).length > 0) {
        data.password = await bcrypt.hash(String(body.password).trim(), BCRYPT_ROUNDS);
        data.tokenVersion = { increment: 1 };
      }

      const updated = await prisma.user.update({
        where: { id: memberId },
        data,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
          lastLoginAt: true,
        },
      });
      sendSuccess(res, { user: updated }, 'User updated');
    } catch (e) {
      sendError(res, e as Error);
    }
  }
);

router.delete(
  '/users/:id',
  requireRole('GYM_ADMIN'),
  validate(gymUserIdParamSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      assertXGymIdMatchesSession(req);
      const gymId = req.gymId!;
      const memberId = Number(req.params.id);
      const caller = req.user!;

      const existing = await prisma.user.findFirst({ where: { id: memberId, gymId } });
      if (!existing) {
        sendError(res, new NotFoundError('User', memberId));
        return;
      }
      if (memberId === caller.id) {
        sendError(res, new ForbiddenError('You cannot remove your own account'));
        return;
      }

      const nextState = { isActive: false, role: existing.role };
      await assertAtLeastOneActiveAdmin(gymId, memberId, nextState);

      await prisma.user.update({
        where: { id: memberId },
        data: { isActive: false, tokenVersion: { increment: 1 } },
      });

      sendSuccess(res, { id: memberId, isActive: false });
    } catch (e) {
      sendError(res, e as Error);
    }
  }
);

export default router;
