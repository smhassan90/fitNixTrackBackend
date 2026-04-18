import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import {
  platformReportsSummaryQuerySchema,
  platformTopMembersQuerySchema,
} from '../../validations/platform';
import { sendSuccess, sendError } from '../../utils/response';
import { parseDate } from '../../utils/dateHelpers';

const router = Router();

const readRoles = [PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT] as const;

router.get(
  '/summary',
  requirePlatformRole(...readRoles),
  validate(platformReportsSummaryQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const { startDate, endDate } = req.query as { startDate: string; endDate: string };
      const rangeStart = parseDate(startDate);
      const rangeEnd = parseDate(endDate);
      rangeEnd.setUTCHours(23, 59, 59, 999);

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const soon = new Date(today);
      soon.setUTCDate(soon.getUTCDate() + 7);

      const [
        totalGyms,
        activeGyms,
        totalMembers,
        totalTrainers,
        collected,
        overdueGymsCount,
        dueSoonGymsCount,
      ] = await Promise.all([
        prisma.gym.count(),
        prisma.gym.count({ where: { tenantStatus: 'ACTIVE' } }),
        prisma.member.count(),
        prisma.trainer.count(),
        prisma.payment.aggregate({
          where: {
            status: 'PAID',
            paidDate: { gte: rangeStart, lte: rangeEnd },
          },
          _sum: { amount: true },
        }),
        prisma.gymSubscription.count({
          where: {
            dueDate: { lt: today },
            gym: { tenantStatus: 'ACTIVE' },
            status: { in: ['ACTIVE', 'PAST_DUE', 'TRIAL'] },
          },
        }),
        prisma.gymSubscription.count({
          where: {
            dueDate: { gte: today, lte: soon },
            gym: { tenantStatus: 'ACTIVE' },
            status: { in: ['ACTIVE', 'TRIAL'] },
          },
        }),
      ]);

      sendSuccess(res, {
        totalGyms,
        activeGyms,
        totalMembers,
        totalTrainers,
        totalCollectedInRange: collected._sum.amount ?? 0,
        overdueGymsCount,
        dueSoonGymsCount,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/gyms/top-by-members',
  requirePlatformRole(...readRoles),
  validate(platformTopMembersQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '10', 10);
      const grouped = await prisma.member.groupBy({
        by: ['gymId'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: limit,
      });
      const gymIds = grouped.map((g) => g.gymId);
      const gyms = await prisma.gym.findMany({
        where: { id: { in: gymIds } },
        select: { id: true, name: true, slug: true, tenantStatus: true },
      });
      const gymMap = new Map(gyms.map((g) => [g.id, g]));
      const rows = grouped.map((g) => ({
        gymId: g.gymId,
        membersCount: g._count.id,
        gym: gymMap.get(g.gymId) ?? null,
      }));
      sendSuccess(res, { gyms: rows });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
