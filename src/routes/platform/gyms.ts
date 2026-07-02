import { Router, Response } from 'express';
import { randomBytes } from 'crypto';
import { generateSyncApiKey } from '../../utils/syncApiKey';
import bcrypt from 'bcryptjs';
import { Prisma, PlatformRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validation';
import { parsePlatformGymMultipart } from '../../middleware/gymLogoMultipart';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import {
  platformCreateGymSchema,
  platformGymIdParamSchema,
  platformGymListQuerySchema,
  platformPatchGymSchema,
  platformGymBillingPaymentCreateSchema,
  platformSubscriptionPatchSchema,
} from '../../validations/platform';
import { sendSuccess, sendError } from '../../utils/response';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../../services/platformAuditService';
import { parseDate } from '../../utils/dateHelpers';
import { locationCatalogService } from '../../services/locationCatalogService';
import { findGymOwnerAdmin } from '../../services/gymOwnerAdminService';
import gymOwnerAdminRoutes from './gymOwnerAdmin';

const router = Router();

const readRoles = [PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT] as const;
const writeRoles = [PlatformRole.SUPER_ADMIN] as const;

function toYmdUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addBillingCycle(ymd: string, billingCycle: string): string {
  const base = new Date(`${ymd}T00:00:00.000Z`);
  const normalized = (billingCycle || '').trim().toUpperCase();
  const match = normalized.match(/^(\d+)\s*(DAY|DAYS|WEEK|WEEKS|MONTH|MONTHS|YEAR|YEARS)$/);
  const quantity = match ? parseInt(match[1], 10) : 1;
  const unit = match ? match[2] : 'MONTH';
  if (unit.startsWith('DAY')) base.setUTCDate(base.getUTCDate() + quantity);
  else if (unit.startsWith('WEEK')) base.setUTCDate(base.getUTCDate() + quantity * 7);
  else if (unit.startsWith('YEAR')) base.setUTCFullYear(base.getUTCFullYear() + quantity);
  else base.setUTCMonth(base.getUTCMonth() + quantity);
  return toYmdUtc(base);
}

async function generateUniqueReceiptNo(): Promise<string> {
  for (let i = 0; i < 10; i += 1) {
    const now = new Date();
    const receiptNo = `RCP-${toYmdUtc(now).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const existing = await prisma.$queryRaw<Array<{ id: number }>>(
      Prisma.sql`SELECT id FROM billing_payments WHERE receiptNo = ${receiptNo} LIMIT 1`
    );
    if (existing.length === 0) return receiptNo;
  }
  throw new ValidationError('Could not allocate receipt number');
}

function paymentAmountsByGym(
  gymIds: number[]
): Promise<Map<number, { pending: number; overdue: number }>> {
  const m = new Map<number, { pending: number; overdue: number }>();
  if (gymIds.length === 0) return Promise.resolve(m);
  return prisma.payment
    .groupBy({
      by: ['gymId', 'status'],
      where: {
        gymId: { in: gymIds },
        status: { in: ['PENDING', 'OVERDUE'] },
      },
      _sum: { amount: true },
    })
    .then((rows) => {
      for (const id of gymIds) m.set(id, { pending: 0, overdue: 0 });
      for (const r of rows) {
        const cur = m.get(r.gymId) || { pending: 0, overdue: 0 };
        const amt = r._sum.amount ?? 0;
        if (r.status === 'PENDING') cur.pending += amt;
        if (r.status === 'OVERDUE') cur.overdue += amt;
        m.set(r.gymId, cur);
      }
      return m;
    });
}

router.get(
  '/',
  requirePlatformRole(...readRoles),
  validate(platformGymListQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const search = q.search?.trim();
      const status = q.status as 'ACTIVE' | 'SUSPENDED' | undefined;
      const planId = q.planId ? parseInt(q.planId, 10) : undefined;
      const dueFrom = q.dueFrom;
      const dueTo = q.dueTo;
      const page = parseInt(q.page || '1', 10);
      const limit = parseInt(q.limit || '20', 10);
      const sortBy = (q.sortBy || 'createdAt') as string;
      const sortOrder = (q.sortOrder || 'desc') as 'asc' | 'desc';

      const where: Prisma.GymWhereInput = {};
      if (search) {
        where.OR = [
          { name: { contains: search } },
          { slug: { contains: search } },
          { email: { contains: search } },
        ];
      }
      if (status) where.tenantStatus = status;

      const subWhere: Prisma.GymSubscriptionWhereInput = {};
      if (planId && !isNaN(planId)) subWhere.planId = planId;
      if (dueFrom || dueTo) {
        subWhere.dueDate = {};
        if (dueFrom) (subWhere.dueDate as Prisma.DateTimeFilter).gte = parseDate(dueFrom);
        if (dueTo) (subWhere.dueDate as Prisma.DateTimeFilter).lte = parseDate(dueTo);
      }
      if (Object.keys(subWhere).length > 0) {
        where.gymSubscription = { is: subWhere };
      }

      let orderBy: Prisma.GymOrderByWithRelationInput[] = [];
      if (sortBy === 'dueDate') {
        orderBy = [{ gymSubscription: { dueDate: sortOrder } }, { id: sortOrder }];
      } else if (sortBy === 'name') {
        orderBy = [{ name: sortOrder }];
      } else {
        orderBy = [{ createdAt: sortOrder }];
      }

      const [total, gyms] = await Promise.all([
        prisma.gym.count({ where }),
        prisma.gym.findMany({
          where,
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
          include: {
            gymSubscription: { include: { plan: true } },
            _count: { select: { members: true, trainers: true } },
          },
        }),
      ]);

      const ids = gyms.map((g) => g.id);
      const amounts = await paymentAmountsByGym(ids);

      const rows = gyms.map((g) => {
        const pm = amounts.get(g.id) || { pending: 0, overdue: 0 };
        return {
          id: g.id,
          name: g.name,
          slug: g.slug,
          logoUrl: g.logoUrl,
          address: g.address,
          city: g.city,
          country: g.country,
          phone: g.phone,
          email: g.email,
          tenantStatus: g.tenantStatus,
          createdAt: g.createdAt,
          membersCount: g._count.members,
          trainersCount: g._count.trainers,
          pendingAmount: pm.pending,
          overdueAmount: pm.overdue,
          dueDate: g.gymSubscription?.dueDate ?? null,
          planName: g.gymSubscription?.plan?.name ?? null,
          planId: g.gymSubscription?.planId ?? null,
          subscriptionStatus: g.gymSubscription?.status ?? null,
        };
      });

      sendSuccess(res, {
        gyms: rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/billing/payments',
  requirePlatformRole(...writeRoles),
  validate(platformGymBillingPaymentCreateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const body = req.body as {
        amountPaid: number;
        currency: string;
        paidAt: string;
        method: 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'JAZZCASH' | 'EASYPAISA';
        notes?: string;
      };

      const gym = await prisma.gym.findUnique({
        where: { id },
        include: { gymSubscription: { include: { plan: true } } },
      });
      if (!gym) {
        sendError(res, new NotFoundError('Gym', id));
        return;
      }
      if (!gym.gymSubscription) {
        sendError(res, new ValidationError('Gym has no subscription'));
        return;
      }

      const dedupe = await prisma.$queryRaw<
        Array<{
          id: number;
          gymId: number;
          amountPaid: number;
          currency: string;
          paidAt: Date;
          method: string;
          notes: string | null;
          status: 'PAID';
          receiptNo: string;
          createdAt: Date;
          createdBy: number;
        }>
      >(Prisma.sql`
        SELECT id, gymId, amountPaid, currency, paidAt, method, notes, status, receiptNo, createdAt, createdBy
        FROM billing_payments
        WHERE gymId = ${id}
          AND amountPaid = ${body.amountPaid}
          AND currency = ${body.currency.trim().toUpperCase()}
          AND paidAt = ${parseDate(body.paidAt)}
          AND method = ${body.method}
          AND createdBy = ${actor.id}
          AND createdAt >= (NOW() - INTERVAL 30 SECOND)
        ORDER BY id DESC
        LIMIT 1
      `);
      if (dedupe.length > 0) {
        const existing = dedupe[0];
        sendSuccess(
          res,
          {
            id: existing.id,
            gymId: existing.gymId,
            amountPaid: existing.amountPaid,
            currency: existing.currency,
            paidAt: toYmdUtc(new Date(existing.paidAt)),
            method: existing.method,
            notes: existing.notes,
            status: existing.status,
            receiptNo: existing.receiptNo,
            createdAt: existing.createdAt,
            createdBy: existing.createdBy,
          },
          'Payment already recorded recently'
        );
        return;
      }

      const receiptNo = await generateUniqueReceiptNo();
      const paidAtDate = parseDate(body.paidAt);
      const normalizedCurrency = body.currency.trim().toUpperCase();
      const normalizedNotes = body.notes?.trim() || null;
      const nextDueDate = addBillingCycle(body.paidAt, gym.gymSubscription.plan.billingCycle);

      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO billing_payments
          (gymId, amountPaid, currency, paidAt, method, notes, status, receiptNo, createdBy, createdAt, updatedAt)
        VALUES
          (${id}, ${body.amountPaid}, ${normalizedCurrency}, ${paidAtDate}, ${body.method}, ${normalizedNotes}, 'PAID', ${receiptNo}, ${actor.id}, NOW(3), NOW(3))
      `);

      const rows = await prisma.$queryRaw<
        Array<{
          id: number;
          gymId: number;
          amountPaid: number;
          currency: string;
          paidAt: Date;
          method: string;
          notes: string | null;
          status: 'PAID';
          receiptNo: string;
          createdAt: Date;
          createdBy: number;
        }>
      >(Prisma.sql`
        SELECT id, gymId, amountPaid, currency, paidAt, method, notes, status, receiptNo, createdAt, createdBy
        FROM billing_payments
        WHERE receiptNo = ${receiptNo}
        LIMIT 1
      `);
      const payment = rows[0];

      await prisma.gymSubscription.update({
        where: { gymId: id },
        data: {
          status: 'ACTIVE',
          lastPaidAt: paidAtDate,
          dueDate: parseDate(nextDueDate),
        },
      });

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'BILLING_PAYMENT_RECORDED',
        targetGymId: id,
        metadata: {
          gymName: gym.name,
          amountPaid: payment.amountPaid,
          currency: payment.currency,
          paidAt: body.paidAt,
          receiptNo: payment.receiptNo,
          method: payment.method,
          actor: actor.email,
        },
      });

      sendSuccess(res, {
        id: payment.id,
        gymId: payment.gymId,
        amountPaid: payment.amountPaid,
        currency: payment.currency,
        paidAt: toYmdUtc(new Date(payment.paidAt)),
        method: payment.method,
        notes: payment.notes,
        status: payment.status,
        receiptNo: payment.receiptNo,
        createdAt: payment.createdAt,
        createdBy: payment.createdBy,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/',
  requirePlatformRole(...writeRoles),
  parsePlatformGymMultipart,
  validate(platformCreateGymSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const {
        name,
        slug,
        logoUrl,
        address,
        city,
        country,
        ownerAdmin,
        planId,
        dueDate,
        isActive,
      } = req.body;

      const plan = await prisma.plan.findUnique({ where: { id: planId } });
      if (!plan) {
        sendError(res, new NotFoundError('Plan', planId));
        return;
      }
      if ((plan as { isActive?: boolean }).isActive === false) {
        sendError(
          res,
          new ValidationError('Selected plan is inactive', {
            code: 'inactive_plan',
            planId,
          })
        );
        return;
      }

      const slugTaken = await prisma.gym.findUnique({ where: { slug } });
      if (slugTaken) {
        sendError(res, new ValidationError('Slug is already in use'));
        return;
      }

      const rawPassword =
        ownerAdmin.password && ownerAdmin.password.length > 0
          ? ownerAdmin.password
          : randomBytes(14).toString('base64url');
      const passwordHash = await bcrypt.hash(rawPassword, 10);

      const tenantStatus = isActive === false ? 'SUSPENDED' : 'ACTIVE';
      const normalizedLocation = await locationCatalogService.validateActiveGymLocation({
        country,
        city,
      });

      const result = await prisma.$transaction(async (tx) => {
        const gym = await tx.gym.create({
          data: {
            name,
            slug,
            logoUrl: logoUrl ?? null,
            address: address ?? null,
            city: normalizedLocation.city,
            country: normalizedLocation.country,
            phone: ownerAdmin.phone ?? null,
            tenantStatus,
          },
        });

        await tx.gym.update({
          where: { id: gym.id },
          data: { syncApiKey: generateSyncApiKey(gym.id) },
        });

        await tx.gymSubscription.create({
          data: {
            gymId: gym.id,
            planId,
            dueDate: parseDate(dueDate),
            status: 'ACTIVE',
          },
        });

        const user = await tx.user.create({
          data: {
            name: ownerAdmin.name,
            email: ownerAdmin.email.toLowerCase().trim(),
            phone: ownerAdmin.phone?.trim() || null,
            password: passwordHash,
            role: 'GYM_ADMIN',
            isActive: true,
            gymId: gym.id,
            gymName: gym.name,
            tokenVersion: 0,
          },
          select: { id: true, email: true, name: true, role: true, gymId: true, createdAt: true },
        });

        return { gym, user };
      });

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'GYM_CREATE',
        targetGymId: result.gym.id,
        metadata: {
          name: result.gym.name,
          slug: result.gym.slug,
          planId,
          dueDate,
        },
      });
      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'USER_CREATE',
        targetGymId: result.gym.id,
        metadata: {
          userId: result.user.id,
          email: result.user.email,
          role: result.user.role,
        },
      });

      sendSuccess(
        res,
        {
          gym: {
            id: result.gym.id,
            name: result.gym.name,
            slug: result.gym.slug,
            tenantStatus: result.gym.tenantStatus,
          },
          ownerAdmin: result.user,
          ...(ownerAdmin.password ? {} : { generatedPassword: rawPassword }),
        },
        'Gym created',
        201
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendError(res, new ValidationError('Unique constraint violation (slug or email)'));
        return;
      }
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/:id',
  requirePlatformRole(...readRoles),
  validate(platformGymIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const gym = await prisma.gym.findUnique({
        where: { id },
        include: {
          gymSubscription: { include: { plan: true } },
          _count: { select: { members: true, trainers: true } },
        },
      });
      if (!gym) {
        sendError(res, new NotFoundError('Gym', id));
        return;
      }
      const [pendingAgg, overdueAgg, ownerAdmin, billingHistory] = await Promise.all([
        prisma.payment.aggregate({
          where: { gymId: id, status: 'PENDING' },
          _sum: { amount: true },
        }),
        prisma.payment.aggregate({
          where: { gymId: id, status: 'OVERDUE' },
          _sum: { amount: true },
        }),
        findGymOwnerAdmin(id),
        prisma.$queryRaw<
        Array<{
          id: number;
          paidAt: Date;
          amountPaid: number;
          status: string;
          notes: string | null;
          receiptNo: string;
          method: string;
          currency: string;
          createdAt: Date;
          createdBy: number;
        }>
      >(Prisma.sql`
        SELECT id, paidAt, amountPaid, status, notes, receiptNo, method, currency, createdAt, createdBy
        FROM billing_payments
        WHERE gymId = ${id}
        ORDER BY paidAt DESC, id DESC
        LIMIT 100
      `),
      ]);

      sendSuccess(res, {
        ...gym,
        membersCount: gym._count.members,
        trainersCount: gym._count.trainers,
        pendingAmount: pendingAgg._sum.amount ?? 0,
        overdueAmount: overdueAgg._sum.amount ?? 0,
        ownerAdmin,
        billingHistory: billingHistory.map((p) => ({
          id: p.id,
          paidAt: toYmdUtc(new Date(p.paidAt)),
          amountPaid: p.amountPaid,
          amount: p.amountPaid,
          status: p.status,
          notes: p.notes,
          receiptNo: p.receiptNo,
          method: p.method,
          currency: p.currency,
          createdAt: p.createdAt,
          createdBy: p.createdBy,
        })),
        subscription: {
          ...gym.gymSubscription,
          paymentHistory: billingHistory.map((p) => ({
            id: p.id,
            paidAt: toYmdUtc(new Date(p.paidAt)),
            amountPaid: p.amountPaid,
            amount: p.amountPaid,
            status: p.status,
            notes: p.notes,
          })),
        },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id',
  requirePlatformRole(...writeRoles),
  parsePlatformGymMultipart,
  validate(platformPatchGymSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.gym.findUnique({ where: { id } });
      if (!existing) {
        sendError(res, new NotFoundError('Gym', id));
        return;
      }

      const body = req.body as Record<string, unknown>;
      const data: Prisma.GymUpdateInput = {};
      const nextCountry =
        body.country !== undefined ? (body.country as string | null) : (existing.country ?? null);
      const nextCity = body.city !== undefined ? (body.city as string | null) : (existing.city ?? null);
      const shouldValidateLocation = body.country !== undefined || body.city !== undefined;
      if (shouldValidateLocation) {
        if (!nextCountry || !nextCity) {
          sendError(
            res,
            new ValidationError('Country and city are required together', {
              code: !nextCountry ? 'invalid_country' : 'invalid_city',
            })
          );
          return;
        }
        const normalizedLocation = await locationCatalogService.validateActiveGymLocation({
          country: nextCountry,
          city: nextCity,
        });
        data.country = normalizedLocation.country;
        data.city = normalizedLocation.city;
      }

      if (body.name !== undefined) data.name = body.name as string;
      if (body.slug !== undefined) data.slug = body.slug as string;
      if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl as string | null;
      if (body.address !== undefined) data.address = body.address as string | null;
      if (body.phone !== undefined) data.phone = body.phone as string | null;
      if (body.email !== undefined) data.email = body.email as string | null;

      const updated = await prisma.gym.update({
        where: { id },
        data,
        include: { gymSubscription: { include: { plan: true } } },
      });

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'GYM_UPDATE',
        targetGymId: id,
        metadata: JSON.parse(
          JSON.stringify({
            before: { name: existing.name, slug: existing.slug },
            fields: body,
          })
        ) as Prisma.InputJsonValue,
      });

      sendSuccess(res, updated, 'Gym updated');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendError(res, new ValidationError('Slug or unique field conflict'));
        return;
      }
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id/suspend',
  requirePlatformRole(...writeRoles),
  validate(platformGymIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const g = await prisma.gym.findUnique({ where: { id } });
      if (!g) {
        sendError(res, new NotFoundError('Gym', id));
        return;
      }
      await prisma.gym.update({ where: { id }, data: { tenantStatus: 'SUSPENDED' } });
      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'GYM_SUSPEND',
        targetGymId: id,
      });
      sendSuccess(res, { id, tenantStatus: 'SUSPENDED' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id/activate',
  requirePlatformRole(...writeRoles),
  validate(platformGymIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const g = await prisma.gym.findUnique({ where: { id } });
      if (!g) {
        sendError(res, new NotFoundError('Gym', id));
        return;
      }
      await prisma.gym.update({ where: { id }, data: { tenantStatus: 'ACTIVE' } });
      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'GYM_ACTIVATE',
        targetGymId: id,
      });
      sendSuccess(res, { id, tenantStatus: 'ACTIVE' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id/subscription',
  requirePlatformRole(...writeRoles),
  validate(platformSubscriptionPatchSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const sub = await prisma.gymSubscription.findUnique({
        where: { gymId: id },
        include: { gym: true },
      });
      if (!sub) {
        sendError(res, new NotFoundError('Gym subscription', id));
        return;
      }

      const { planId, dueDate, markPaidAt, notes } = req.body as {
        planId?: number;
        dueDate?: string;
        markPaidAt?: string;
        notes?: string | null;
      };

      if (planId) {
        const plan = await prisma.plan.findUnique({ where: { id: planId } });
        if (!plan) {
          sendError(res, new NotFoundError('Plan', planId));
          return;
        }
      }

      const data: Prisma.GymSubscriptionUpdateInput = {};
      if (planId) data.plan = { connect: { id: planId } };
      if (dueDate) data.dueDate = parseDate(dueDate);
      if (notes !== undefined) data.notes = notes;

      if (markPaidAt) {
        data.lastPaidAt = parseDate(markPaidAt);
      }

      const updated = await prisma.gymSubscription.update({
        where: { gymId: id },
        data,
        include: { plan: true },
      });

      if (planId) {
        await writePlatformAuditLog({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'PLAN_CHANGE',
          targetGymId: id,
          metadata: { planId },
        });
      }
      if (dueDate) {
        await writePlatformAuditLog({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'DUE_DATE_EXTEND',
          targetGymId: id,
          metadata: { dueDate },
        });
      }
      if (markPaidAt) {
        await writePlatformAuditLog({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'MARK_PAID',
          targetGymId: id,
          metadata: { markPaidAt },
        });
      }
      if (!planId && !dueDate && !markPaidAt && notes !== undefined) {
        await writePlatformAuditLog({
          actorUserId: actor.id,
          actorRole: actor.role,
          actionType: 'SUBSCRIPTION_UPDATE',
          targetGymId: id,
          metadata: { notes: true },
        });
      }

      sendSuccess(res, updated, 'Subscription updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.use(gymOwnerAdminRoutes);

export default router;
