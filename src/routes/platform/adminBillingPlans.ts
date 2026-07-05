import { Router, Response } from 'express';
import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import { validate } from '../../middleware/validation';
import {
  platformBillingPlanCreateSchema,
  platformBillingPlanDeleteParamSchema,
  platformBillingPlanPatchSchema,
  platformBillingPlansQuerySchema,
} from '../../validations/platform';
import { sendError, sendSuccess } from '../../utils/response';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../../services/platformAuditService';
import { serializePlatformPlan } from '../../utils/planPricing';

const router = Router();
const readRoles = [PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT] as const;

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

router.get(
  '/admin/billing/plans',
  requirePlatformRole(...readRoles),
  validate(platformBillingPlansQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const active = q.active;
      const plans = await prisma.plan.findMany({
        where: {
          deletedAt: null,
          ...(active === 'true'
            ? { isActive: true }
            : active === 'false'
              ? { isActive: false }
              : {}),
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      sendSuccess(
        res,
        plans.map((p) => serializePlatformPlan(p))
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/admin/billing/plans',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformBillingPlanCreateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const body = req.body as {
        name: string;
        code: string;
        description?: string | null;
        price: number;
        currency: string;
        billingCycle?: 'MONTHLY' | 'BIANNUAL' | 'ANNUAL';
        maxMembers?: number | null;
        features?: Prisma.InputJsonValue;
        isActive?: boolean;
        sortOrder?: number;
      };
      const code = normalizeCode(body.code);
      const currency = normalizeCurrency(body.currency);
      const billingCycle = (body.billingCycle || 'MONTHLY').toUpperCase();

      const existing = await prisma.plan.findFirst({
        where: { code, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
      }

      let plan;
      try {
        plan = await prisma.plan.create({
          data: {
            name: body.name.trim(),
            code,
            description: body.description ?? null,
            price: body.price,
            currency,
            billingCycle,
            maxMembers: body.maxMembers ?? null,
            features: body.features === undefined ? undefined : body.features,
            isActive: body.isActive ?? true,
            sortOrder: body.sortOrder ?? 0,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
        }
        throw error;
      }

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'BILLING_PLAN_CREATE',
        metadata: { planId: plan.id, code: plan.code, name: plan.name, maxMembers: plan.maxMembers },
      });

      sendSuccess(res, serializePlatformPlan(plan), 'Billing plan created', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/admin/billing/plans/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformBillingPlanPatchSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);
      const body = req.body as Record<string, unknown>;

      const existing = await prisma.plan.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundError('Billing plan', id);
      }

      if (body.code !== undefined) {
        const nextCode = normalizeCode(String(body.code));
        const dup = await prisma.plan.findFirst({
          where: { code: nextCode, id: { not: id }, deletedAt: null },
          select: { id: true },
        });
        if (dup) {
          throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
        }
      }

      const data: Prisma.PlanUpdateInput = {};
      if (body.name !== undefined) data.name = String(body.name).trim();
      if (body.code !== undefined) data.code = normalizeCode(String(body.code));
      if (body.description !== undefined) data.description = (body.description as string | null) ?? null;
      if (body.price !== undefined) data.price = Number(body.price);
      if (body.currency !== undefined) data.currency = normalizeCurrency(String(body.currency));
      if (body.billingCycle !== undefined) data.billingCycle = String(body.billingCycle).toUpperCase();
      if (body.maxMembers !== undefined) {
        data.maxMembers = body.maxMembers === null ? null : Number(body.maxMembers);
      }
      if (body.features !== undefined) {
        data.features =
          body.features === null ? Prisma.JsonNull : (body.features as Prisma.InputJsonValue);
      }
      if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
      if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder);

      let plan;
      try {
        plan = await prisma.plan.update({ where: { id }, data });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
        }
        throw error;
      }

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'BILLING_PLAN_UPDATE',
        metadata: JSON.parse(JSON.stringify({ planId: id, fields: body })) as Prisma.InputJsonValue,
      });

      sendSuccess(res, serializePlatformPlan(plan));
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/admin/billing/plans/:id',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(platformBillingPlanDeleteParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const actor = req.platformUser!;
      const id = parseInt(req.params.id, 10);

      const existing = await prisma.plan.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!existing) {
        throw new NotFoundError('Billing plan', id);
      }

      const inUse = await prisma.gymSubscription.count({
        where: {
          planId: id,
          status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] },
        },
      });
      if (inUse > 0) {
        throw new AppError('PLAN_IN_USE', 'Plan is currently in use by active gym subscriptions', 409);
      }

      await prisma.plan.update({
        where: { id },
        data: { isActive: false, deletedAt: new Date() },
      });

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'BILLING_PLAN_DELETE',
        metadata: { planId: id, name: existing.name },
      });

      sendSuccess(res, { id, deleted: true }, 'Billing plan deleted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
