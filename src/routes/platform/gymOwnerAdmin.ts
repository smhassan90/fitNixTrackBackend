import { Router, Response } from 'express';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import {
  platformGymIdParamSchema,
  platformGymOwnerAdminCreateSchema,
  platformGymOwnerAdminResetPasswordSchema,
  platformGymOwnerAdminUpdateSchema,
} from '../../validations/platform';
import { sendSuccess, sendError } from '../../utils/response';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { writePlatformAuditLog } from '../../services/platformAuditService';
import {
  findGymOwnerAdmin,
  ownerAdminSelect,
  OWNER_ADMIN_EXISTS_MESSAGE,
  toOwnerAdminDto,
} from '../../services/gymOwnerAdminService';

const router = Router();
const BCRYPT_ROUNDS = 10;

const readRoles = [PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT] as const;
const writeRoles = [PlatformRole.SUPER_ADMIN] as const;

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

router.get(
  '/:id/owner-admin',
  requirePlatformRole(...readRoles),
  validate(platformGymIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = parseInt(req.params.id, 10);
      const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { id: true } });
      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const ownerAdmin = await findGymOwnerAdmin(gymId);
      sendSuccess(res, { ownerAdmin });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/owner-admin',
  requirePlatformRole(...writeRoles),
  validate(platformGymOwnerAdminCreateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const gymId = parseInt(req.params.id, 10);
      const { name, email, phone, password } = req.body as {
        name: string;
        email: string;
        phone?: string | null;
        password?: string;
      };

      const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { id: true, name: true } });
      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const existingAdmin = await findGymOwnerAdmin(gymId);
      if (existingAdmin) {
        sendError(
          res,
          new ConflictError(OWNER_ADMIN_EXISTS_MESSAGE, { ownerAdmin: existingAdmin })
        );
        return;
      }

      const normEmail = normalizeEmail(email);
      const dup = await prisma.user.findFirst({
        where: { gymId, email: normEmail },
        select: ownerAdminSelect,
      });
      if (dup) {
        sendError(
          res,
          new ConflictError('A user with this email already exists in this gym', {
            ...(dup.role === 'GYM_ADMIN' ? { ownerAdmin: toOwnerAdminDto(dup) } : { user: toOwnerAdminDto(dup) }),
          })
        );
        return;
      }

      const plainPassword =
        password && password.length > 0 ? password : randomBytes(14).toString('base64url');
      const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

      const ownerAdmin = toOwnerAdminDto(
        await prisma.user.create({
          data: {
            name: name.trim(),
            email: normEmail,
            phone: phone && String(phone).trim() ? String(phone).trim() : null,
            password: passwordHash,
            role: 'GYM_ADMIN',
            gymId,
            gymName: gym.name,
            isActive: true,
            tokenVersion: 0,
          },
          select: ownerAdminSelect,
        })
      );

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'USER_CREATE',
        targetGymId: gymId,
        metadata: {
          userId: ownerAdmin.id,
          email: ownerAdmin.email,
          role: ownerAdmin.role,
          source: 'platform_owner_admin_create',
        },
      });

      sendSuccess(
        res,
        {
          ownerAdmin,
          ...(password ? {} : { generatedPassword: plainPassword }),
        },
        'Gym owner admin created',
        201
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendError(res, new ConflictError('Email is already in use'));
        return;
      }
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id/owner-admin',
  requirePlatformRole(...writeRoles),
  validate(platformGymOwnerAdminUpdateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const gymId = parseInt(req.params.id, 10);
      const body = req.body as {
        name?: string;
        email?: string;
        phone?: string | null;
        isActive?: boolean;
      };

      const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { id: true, name: true } });
      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const existingAdmin = await prisma.user.findFirst({
        where: { gymId, role: 'GYM_ADMIN' },
        orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
        select: { id: true, email: true },
      });
      if (!existingAdmin) {
        sendError(
          res,
          new NotFoundError('Gym owner admin — create one first from the platform portal')
        );
        return;
      }

      const data: Prisma.UserUpdateInput = {};
      if (body.name !== undefined) data.name = body.name.trim();
      if (body.phone !== undefined) {
        data.phone = body.phone && String(body.phone).trim() ? String(body.phone).trim() : null;
      }
      if (body.isActive !== undefined) data.isActive = body.isActive;

      let emailChanged = false;
      if (body.email !== undefined) {
        const normEmail = normalizeEmail(body.email);
        if (normEmail !== existingAdmin.email) {
          const dup = await prisma.user.findFirst({
            where: { gymId, email: normEmail, id: { not: existingAdmin.id } },
            select: { id: true },
          });
          if (dup) {
            sendError(res, new ConflictError('A user with this email already exists in this gym'));
            return;
          }
          data.email = normEmail;
          emailChanged = true;
        }
      }

      if (emailChanged) {
        data.tokenVersion = { increment: 1 };
      }

      const ownerAdmin = toOwnerAdminDto(
        await prisma.user.update({
          where: { id: existingAdmin.id },
          data,
          select: ownerAdminSelect,
        })
      );

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'GYM_OWNER_UPDATE',
        targetGymId: gymId,
        metadata: {
          userId: ownerAdmin.id,
          email: ownerAdmin.email,
          fields: Object.keys(body),
        },
      });

      sendSuccess(res, { ownerAdmin }, 'Gym owner admin updated');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendError(res, new ConflictError('Email is already in use'));
        return;
      }
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/owner-admin/reset-password',
  requirePlatformRole(...writeRoles),
  validate(platformGymOwnerAdminResetPasswordSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const gymId = parseInt(req.params.id, 10);
      const { password } = req.body as { password?: string };

      const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { id: true, name: true } });
      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const existingAdmin = await prisma.user.findFirst({
        where: { gymId, role: 'GYM_ADMIN' },
        orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (!existingAdmin) {
        sendError(
          res,
          new NotFoundError('Gym owner admin — create one first from the platform portal')
        );
        return;
      }

      const plainPassword =
        password && password.length > 0 ? password : randomBytes(14).toString('base64url');
      const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

      const ownerAdmin = toOwnerAdminDto(
        await prisma.user.update({
          where: { id: existingAdmin.id },
          data: {
            password: passwordHash,
            isActive: true,
            tokenVersion: { increment: 1 },
          },
          select: ownerAdminSelect,
        })
      );

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'GYM_OWNER_PASSWORD_RESET',
        targetGymId: gymId,
        metadata: {
          userId: ownerAdmin.id,
          email: ownerAdmin.email,
          actor: actor.email,
        },
      });

      sendSuccess(res, {
        ownerAdmin,
        ...(password ? {} : { generatedPassword: plainPassword }),
      }, 'Owner admin password reset');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
