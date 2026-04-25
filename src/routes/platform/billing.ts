import { Router, Response } from 'express';
import { Prisma, PlatformRole, GymSubscriptionStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import { platformBillingDuesQuerySchema, platformBillingPlansQuerySchema } from '../../validations/platform';
import { sendSuccess, sendError } from '../../utils/response';
const router = Router();

const readRoles = [PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT] as const;

router.get(
  '/plans',
  requirePlatformRole(...readRoles),
  validate(platformBillingPlansQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const active = q.active;
      const activeFilter =
        active === undefined
          ? Prisma.sql``
          : active === 'true'
            ? Prisma.sql`AND isActive = TRUE`
            : Prisma.sql`AND isActive = FALSE`;
      const plans = await prisma.$queryRaw<
        Array<{
          id: number;
          name: string;
          code: string | null;
          description: string | null;
          price: number;
          currency: string;
          billingCycle: string;
          isActive: boolean;
          sortOrder: number;
        }>
      >(Prisma.sql`
        SELECT
          id,
          name,
          code,
          description,
          price,
          currency,
          billingCycle,
          isActive,
          sortOrder
        FROM plans
        WHERE deletedAt IS NULL
        ${activeFilter}
        ORDER BY sortOrder ASC, name ASC
      `);
      sendSuccess(
        res,
        plans.map((p) => ({
          id: p.id,
          name: p.name,
          packageName: p.name,
          code: p.code,
          description: (p as { description?: string | null }).description ?? null,
          price: p.price,
          amount: p.price,
          currency: p.currency,
          billingCycle: p.billingCycle,
          isActive: p.isActive,
          status: p.isActive ? 'ACTIVE' : 'INACTIVE',
          sortOrder: p.sortOrder,
        }))
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/dues',
  requirePlatformRole(...readRoles),
  validate(platformBillingDuesQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const page = parseInt(q.page || '1', 10);
      const limit = parseInt(q.limit || '50', 10);
      const planId = q.planId ? parseInt(q.planId, 10) : undefined;
      const status = q.status as GymSubscriptionStatus | undefined;
      const overdue = q.overdue;
      const dueInDays = q.dueInDays ? parseInt(q.dueInDays, 10) : undefined;

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const where: Prisma.GymSubscriptionWhereInput = {
        gym: { tenantStatus: 'ACTIVE' },
      };

      if (planId && !isNaN(planId)) where.planId = planId;
      if (status) where.status = status;

      if (overdue === 'true') {
        where.dueDate = { lt: today };
      } else if (dueInDays !== undefined && !isNaN(dueInDays)) {
        const end = new Date(today);
        end.setUTCDate(end.getUTCDate() + dueInDays);
        where.dueDate = { gte: today, lte: end };
      }

      const [total, rows] = await Promise.all([
        prisma.gymSubscription.count({ where }),
        prisma.gymSubscription.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          include: {
            gym: { select: { id: true, name: true, slug: true, tenantStatus: true } },
            plan: { select: { id: true, name: true, price: true, billingCycle: true } },
          },
          orderBy: { dueDate: 'asc' },
        }),
      ]);
      const gymIds = rows.map((r) => r.gymId);
      const paymentAgg =
        gymIds.length === 0
          ? []
          : await prisma.$queryRaw<
              Array<{
                gymId: number;
                amountCollected: number;
                lastPaidAt: Date | null;
                paymentHistoryCount: number;
              }>
            >(Prisma.sql`
              SELECT
                gymId,
                COALESCE(SUM(amountPaid), 0) AS amountCollected,
                MAX(paidAt) AS lastPaidAt,
                COUNT(*) AS paymentHistoryCount
              FROM billing_payments
              WHERE gymId IN (${Prisma.join(gymIds)})
              GROUP BY gymId
            `);
      const paymentMap = new Map(
        paymentAgg.map((p) => [p.gymId, p] as const)
      );

      const msPerDay = 86400000;
      const data = rows.map((r) => {
        const due = new Date(r.dueDate);
        due.setUTCHours(0, 0, 0, 0);
        const daysOverdue = due.getTime() < today.getTime()
          ? Math.floor((today.getTime() - due.getTime()) / msPerDay)
          : 0;
        const paymentInfo = paymentMap.get(r.gymId);
        return {
          gymId: r.gymId,
          gymName: r.gym.name,
          slug: r.gym.slug,
          tenantStatus: r.gym.tenantStatus,
          dueDate: r.dueDate,
          daysOverdue,
          amountDue: r.plan.price,
          amountCollected: paymentInfo?.amountCollected ?? 0,
          collectedAmount: paymentInfo?.amountCollected ?? 0,
          lastPaidAt: paymentInfo?.lastPaidAt ?? null,
          paymentHistoryCount: paymentInfo?.paymentHistoryCount ?? 0,
          planName: r.plan.name,
          subscriptionStatus: r.status,
        };
      });

      sendSuccess(res, {
        items: data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
