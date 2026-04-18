import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import { platformAuditLogsQuerySchema } from '../../validations/platform';
import { sendSuccess, sendError } from '../../utils/response';

const router = Router();

router.get(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformAuditLogsQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const page = parseInt(q.page || '1', 10);
      const limit = parseInt(q.limit || '50', 10);
      const actionType = q.actionType?.trim();
      const targetGymId = q.targetGymId ? parseInt(q.targetGymId, 10) : undefined;

      const where: {
        actionType?: string;
        targetGymId?: number;
      } = {};
      if (actionType) where.actionType = actionType;
      if (targetGymId && !isNaN(targetGymId)) where.targetGymId = targetGymId;

      const [total, logs] = await Promise.all([
        prisma.platformAuditLog.count({ where }),
        prisma.platformAuditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            actorUserId: true,
            actorRole: true,
            actionType: true,
            targetGymId: true,
            metadata: true,
            createdAt: true,
          },
        }),
      ]);

      sendSuccess(res, {
        logs,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
