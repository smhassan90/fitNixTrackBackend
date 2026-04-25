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
      const activeFilter =
        active === undefined
          ? Prisma.sql``
          : active === 'true'
            ? Prisma.sql`AND isActive = TRUE`
            : Prisma.sql`AND isActive = FALSE`;
      const rows = await prisma.$queryRaw<
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
          createdAt: Date;
          updatedAt: Date;
          deletedAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT id, name, code, description, price, currency, billingCycle, isActive, sortOrder, createdAt, updatedAt, deletedAt
        FROM plans
        WHERE deletedAt IS NULL
        ${activeFilter}
        ORDER BY sortOrder ASC, name ASC
      `);
      sendSuccess(
        res,
        rows.map((r) => ({
          ...r,
          amount: r.price,
          packageName: r.name,
          status: r.isActive ? 'ACTIVE' : 'INACTIVE',
        }))
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
        billingCycle: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
        isActive?: boolean;
        sortOrder?: number;
      };
      const code = normalizeCode(body.code);
      const currency = normalizeCurrency(body.currency);
      const codeDup = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT id FROM plans WHERE code = ${code} AND deletedAt IS NULL LIMIT 1
      `);
      if (codeDup.length > 0) {
        throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
      }

      try {
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO plans
            (name, code, description, price, currency, billingCycle, isActive, sortOrder, createdAt, updatedAt, deletedAt)
          VALUES
            (${body.name.trim()}, ${code}, ${body.description ?? null}, ${body.price}, ${currency}, ${body.billingCycle}, ${body.isActive ?? true}, ${body.sortOrder ?? 0}, NOW(3), NOW(3), NULL)
        `);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
        }
        throw error;
      }

      const rows = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT id, name, code, description, price, currency, billingCycle, isActive, sortOrder, createdAt, updatedAt, deletedAt
        FROM plans WHERE code = ${code} LIMIT 1
      `);
      const plan = rows[0];

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'BILLING_PLAN_CREATE',
        metadata: { planId: plan.id, code: plan.code, name: plan.name },
      });

      sendSuccess(
        res,
        { ...plan, amount: plan.price, packageName: plan.name, status: plan.isActive ? 'ACTIVE' : 'INACTIVE' },
        'Billing plan created',
        201
      );
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
      const existing = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT id FROM plans WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
      `);
      if (existing.length === 0) {
        throw new NotFoundError('Billing plan', id);
      }

      const updates: Prisma.Sql[] = [];
      if (body.name !== undefined) updates.push(Prisma.sql`name = ${String(body.name).trim()}`);
      if (body.code !== undefined) updates.push(Prisma.sql`code = ${normalizeCode(String(body.code))}`);
      if (body.description !== undefined) updates.push(Prisma.sql`description = ${body.description ?? null}`);
      if (body.price !== undefined) updates.push(Prisma.sql`price = ${Number(body.price)}`);
      if (body.currency !== undefined) {
        updates.push(Prisma.sql`currency = ${normalizeCurrency(String(body.currency))}`);
      }
      if (body.billingCycle !== undefined) updates.push(Prisma.sql`billingCycle = ${String(body.billingCycle)}`);
      if (body.isActive !== undefined) updates.push(Prisma.sql`isActive = ${Boolean(body.isActive)}`);
      if (body.sortOrder !== undefined) updates.push(Prisma.sql`sortOrder = ${Number(body.sortOrder)}`);
      updates.push(Prisma.sql`updatedAt = NOW(3)`);
      if (body.code !== undefined) {
        const nextCode = normalizeCode(String(body.code));
        const dup = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
          SELECT id FROM plans WHERE code = ${nextCode} AND id <> ${id} AND deletedAt IS NULL LIMIT 1
        `);
        if (dup.length > 0) {
          throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
        }
      }

      try {
        await prisma.$executeRaw(
          Prisma.sql`UPDATE plans SET ${Prisma.join(updates)} WHERE id = ${id}`
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ValidationError('Plan code already exists', { code: 'VALIDATION_ERROR', field: 'code' });
        }
        throw error;
      }

      const rows = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT id, name, code, description, price, currency, billingCycle, isActive, sortOrder, createdAt, updatedAt, deletedAt
        FROM plans WHERE id = ${id} LIMIT 1
      `);
      const plan = rows[0];

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'BILLING_PLAN_UPDATE',
        metadata: JSON.parse(
          JSON.stringify({ planId: id, fields: body })
        ) as Prisma.InputJsonValue,
      });

      sendSuccess(res, {
        ...plan,
        amount: plan.price,
        packageName: plan.name,
        status: plan.isActive ? 'ACTIVE' : 'INACTIVE',
      });
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

      const existing = await prisma.$queryRaw<Array<{ id: number; name: string }>>(Prisma.sql`
        SELECT id, name FROM plans WHERE id = ${id} AND deletedAt IS NULL LIMIT 1
      `);
      if (existing.length === 0) {
        throw new NotFoundError('Billing plan', id);
      }

      const inUse = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) as count
        FROM gym_subscriptions
        WHERE planId = ${id} AND status IN ('ACTIVE','TRIAL','PAST_DUE')
      `);
      if (inUse.length > 0 && inUse[0].count > BigInt(0)) {
        throw new AppError('PLAN_IN_USE', 'Plan is currently in use by active gym subscriptions', 409);
      }

      await prisma.$executeRaw(Prisma.sql`
        UPDATE plans
        SET isActive = FALSE, deletedAt = NOW(3), updatedAt = NOW(3)
        WHERE id = ${id}
      `);

      await writePlatformAuditLog({
        actorUserId: actor.id,
        actorRole: actor.role,
        actionType: 'BILLING_PLAN_DELETE',
        metadata: { planId: id, name: existing[0].name },
      });

      sendSuccess(res, { id, deleted: true }, 'Billing plan deleted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
