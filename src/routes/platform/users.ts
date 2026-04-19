import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import {
  platformOperatorUserCreateSchema,
  platformOperatorUserIdParamSchema,
  platformOperatorUserPatchSchema,
  platformOperatorUsersQuerySchema,
} from '../../validations/platform';
import { sendSuccess, sendError } from '../../utils/response';
import { NotFoundError, ForbiddenError, ConflictError } from '../../utils/errors';
import { permissionKeysFromJson, toPlatformUserDto } from '../../services/platformUserDto';

const router = Router();

/**
 * Operator user listing and detail (GET /, GET /:id): **SUPER_ADMIN only**.
 * PLATFORM_SUPPORT must not enumerate operator accounts; they may use `/permissions`
 * and other role-scoped routes without access to this directory.
 */
router.get(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformOperatorUsersQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as unknown as {
        search?: string;
        role?: PlatformRole;
        isActive?: 'true' | 'false';
        page: number;
        limit: number;
      };

      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      const where: Prisma.PlatformUserWhereInput = {};

      if (q.search?.trim()) {
        const s = q.search.trim();
        where.OR = [
          { name: { contains: s } },
          { email: { contains: s } },
        ];
      }
      if (q.role) where.role = q.role;
      if (q.isActive !== undefined) where.isActive = q.isActive === 'true';

      const [total, rows] = await Promise.all([
        prisma.platformUser.count({ where }),
        prisma.platformUser.findMany({
          where,
          orderBy: { id: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            permissionKeys: true,
            createdAt: true,
            updatedAt: true,
            lastLoginAt: true,
          },
        }),
      ]);

      sendSuccess(res, {
        users: rows.map((u) => toPlatformUserDto(u)),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformOperatorUserIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const row = await prisma.platformUser.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          permissionKeys: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
        },
      });
      if (!row) {
        sendError(res, new NotFoundError('Platform user', id));
        return;
      }
      sendSuccess(res, { user: toPlatformUserDto(row) });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformOperatorUserCreateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const { name, email, password, role, isActive, permissionKeys } = req.body as {
        name: string;
        email: string;
        password?: string;
        role: PlatformRole;
        isActive: boolean;
        permissionKeys?: string[];
      };

      const emailNorm = email.toLowerCase().trim();
      let plainPassword = password;
      let generatedPassword: string | undefined;
      if (!plainPassword) {
        generatedPassword = randomBytes(14).toString('base64url');
        plainPassword = generatedPassword;
      }

      const hashed = await bcrypt.hash(plainPassword, 10);
      const keys = permissionKeys ?? [];

      const created = await prisma.platformUser.create({
        data: {
          name: name.trim(),
          email: emailNorm,
          password: hashed,
          role,
          isActive,
          permissionKeys: keys as Prisma.InputJsonValue,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          permissionKeys: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
        },
      });

      const user = toPlatformUserDto(created);
      if (generatedPassword !== undefined) {
        sendSuccess(res, { user, generatedPassword }, undefined, 201);
      } else {
        sendSuccess(res, { user }, undefined, 201);
      }
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
  '/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformOperatorUserPatchSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const body = req.body as {
        name?: string;
        email?: string;
        password?: string;
        role?: PlatformRole;
        isActive?: boolean;
        permissionKeys?: string[];
      };

      const existing = await prisma.platformUser.findUnique({ where: { id } });
      if (!existing) {
        sendError(res, new NotFoundError('Platform user', id));
        return;
      }

      const superAdminCount = await prisma.platformUser.count({
        where: { role: PlatformRole.SUPER_ADMIN },
      });

      if (body.role !== undefined && body.role !== PlatformRole.SUPER_ADMIN) {
        if (existing.role === PlatformRole.SUPER_ADMIN && superAdminCount <= 1) {
          sendError(
            res,
            new ConflictError('Cannot change role: at least one SUPER_ADMIN must remain.')
          );
          return;
        }
      }

      if (body.isActive === false && existing.role === PlatformRole.SUPER_ADMIN) {
        const otherActiveSuperAdmins = await prisma.platformUser.count({
          where: {
            role: PlatformRole.SUPER_ADMIN,
            isActive: true,
            id: { not: id },
          },
        });
        if (otherActiveSuperAdmins < 1) {
          sendError(
            res,
            new ConflictError(
              'Cannot deactivate: another active SUPER_ADMIN is required so the platform stays manageable.'
            )
          );
          return;
        }
      }

      const data: Prisma.PlatformUserUpdateInput = {};
      if (body.name !== undefined) data.name = body.name.trim();
      if (body.email !== undefined) data.email = body.email.toLowerCase().trim();
      if (body.password !== undefined) data.password = await bcrypt.hash(body.password, 10);
      if (body.role !== undefined) data.role = body.role;
      if (body.isActive !== undefined) data.isActive = body.isActive;
      if (body.permissionKeys !== undefined) {
        data.permissionKeys = body.permissionKeys.length ? body.permissionKeys : [];
      }

      const updated = await prisma.platformUser.update({
        where: { id },
        data,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          permissionKeys: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
        },
      });

      sendSuccess(res, { user: toPlatformUserDto(updated) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendError(res, new ConflictError('Email is already in use'));
        return;
      }
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformOperatorUserIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const actor = req.platformUser!;

      if (id === actor.id) {
        sendError(res, new ForbiddenError('You cannot delete your own platform account'));
        return;
      }

      const target = await prisma.platformUser.findUnique({ where: { id } });
      if (!target) {
        sendError(res, new NotFoundError('Platform user', id));
        return;
      }

      if (target.role === PlatformRole.SUPER_ADMIN) {
        const superAdmins = await prisma.platformUser.count({
          where: { role: PlatformRole.SUPER_ADMIN },
        });
        if (superAdmins <= 1) {
          sendError(res, new ConflictError('Cannot delete the last SUPER_ADMIN'));
          return;
        }
      }

      await prisma.platformUser.delete({ where: { id } });
      sendSuccess(res, { ok: true });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
