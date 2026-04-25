import { Router, Response } from 'express';
import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import { validate } from '../../middleware/validation';
import {
  platformPackageFeatureCreateSchema,
  platformPackageFeatureDeleteParamSchema,
  platformPackageFeaturePatchSchema,
} from '../../validations/platform';
import { sendError, sendSuccess } from '../../utils/response';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../../services/platformAuditService';

const router = Router();

function normalizeCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return code.trim().toUpperCase();
}

router.post(
  '/admin/packages/features',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPackageFeatureCreateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const body = req.body as {
        name: string;
        code?: string | null;
        description?: string | null;
        isActive?: boolean;
        sortOrder?: number;
      };

      const name = body.name.trim();
      const code = normalizeCode(body.code);
      const duplicate = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT id FROM features WHERE (name = ${name} OR (${code} IS NOT NULL AND code = ${code})) AND deletedAt IS NULL LIMIT 1
      `);
      if (duplicate.length > 0) {
        throw new ValidationError('Feature already exists', { code: 'VALIDATION_ERROR' });
      }

      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO features (name, code, description, isActive, sortOrder, createdAt, updatedAt, deletedAt)
        VALUES (${name}, ${code}, ${body.description ?? null}, ${body.isActive ?? true}, ${body.sortOrder ?? 0}, NOW(3), NOW(3), NULL)
      `);
      const rows = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT id, name, code, description, isActive, sortOrder, createdAt, updatedAt, deletedAt
        FROM features WHERE name = ${name} ORDER BY id DESC LIMIT 1
      `);
      const feature = rows[0];

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'PACKAGE_FEATURE_CREATE',
        metadata: { featureId: feature.id, name: feature.name } as Prisma.InputJsonValue,
      });
      sendSuccess(res, feature, 'Feature created', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/admin/packages/features/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPackageFeaturePatchSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const body = req.body as Record<string, unknown>;
      const existing = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT id FROM features WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
      `);
      if (existing.length === 0) throw new NotFoundError('Feature', id);

      const nextName = body.name !== undefined ? String(body.name).trim() : undefined;
      const nextCode = body.code !== undefined ? normalizeCode(String(body.code)) : undefined;
      if (nextName !== undefined || nextCode !== undefined) {
        const duplicate = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
          SELECT id FROM features
          WHERE id <> ${id}
            AND deletedAt IS NULL
            AND (
              (${nextName ?? null} IS NOT NULL AND name = ${nextName ?? null})
              OR (${nextCode ?? null} IS NOT NULL AND code = ${nextCode ?? null})
            )
          LIMIT 1
        `);
        if (duplicate.length > 0) {
          throw new ValidationError('Feature already exists', { code: 'VALIDATION_ERROR' });
        }
      }

      const updates: Prisma.Sql[] = [];
      if (body.name !== undefined) updates.push(Prisma.sql`name = ${nextName}`);
      if (body.code !== undefined) updates.push(Prisma.sql`code = ${nextCode}`);
      if (body.description !== undefined) updates.push(Prisma.sql`description = ${body.description ?? null}`);
      if (body.isActive !== undefined) updates.push(Prisma.sql`isActive = ${Boolean(body.isActive)}`);
      if (body.sortOrder !== undefined) updates.push(Prisma.sql`sortOrder = ${Number(body.sortOrder)}`);
      updates.push(Prisma.sql`updatedAt = NOW(3)`);

      await prisma.$executeRaw(Prisma.sql`
        UPDATE features
        SET ${Prisma.join(updates)}
        WHERE id = ${id}
      `);

      const rows = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT id, name, code, description, isActive, sortOrder, createdAt, updatedAt, deletedAt
        FROM features WHERE id = ${id} LIMIT 1
      `);
      const feature = rows[0];

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'PACKAGE_FEATURE_UPDATE',
        metadata: JSON.parse(JSON.stringify({ featureId: id, fields: body })) as Prisma.InputJsonValue,
      });
      sendSuccess(res, feature, 'Feature updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/admin/packages/features/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformPackageFeatureDeleteParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.$queryRaw<Array<{ id: number; name: string }>>(Prisma.sql`
        SELECT id, name FROM features WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
      `);
      if (existing.length === 0) throw new NotFoundError('Feature', id);

      const inUse = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) as count FROM package_features WHERE featureId = ${id}
      `);
      if (inUse.length > 0 && inUse[0].count > BigInt(0)) {
        throw new AppError('FEATURE_IN_USE', 'Feature is assigned to one or more packages', 409);
      }

      await prisma.$executeRaw(Prisma.sql`
        UPDATE features
        SET isActive = FALSE, deletedAt = NOW(3), updatedAt = NOW(3)
        WHERE id = ${id}
      `);
      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'PACKAGE_FEATURE_DELETE',
        metadata: { featureId: id, name: existing[0].name } as Prisma.InputJsonValue,
      });
      sendSuccess(res, { id, deleted: true }, 'Feature deleted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
