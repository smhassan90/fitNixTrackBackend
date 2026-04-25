import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export type PlatformAuditAction =
  | 'GYM_CREATE'
  | 'GYM_UPDATE'
  | 'GYM_SUSPEND'
  | 'GYM_ACTIVATE'
  | 'USER_CREATE'
  | 'DUE_DATE_EXTEND'
  | 'PLAN_CHANGE'
  | 'MARK_PAID'
  | 'PLATFORM_LOGIN'
  | 'PLATFORM_LOGOUT'
  | 'SUBSCRIPTION_UPDATE'
  | 'LOCATION_COUNTRY_CREATE'
  | 'LOCATION_COUNTRY_UPDATE'
  | 'LOCATION_CITY_CREATE'
  | 'LOCATION_CITY_UPDATE'
  | 'BILLING_PAYMENT_RECORDED';

export async function writePlatformAuditLog(params: {
  actorUserId: number;
  actorRole: string;
  actionType: PlatformAuditAction | string;
  targetGymId?: number | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  await prisma.platformAuditLog.create({
    data: {
      actorUserId: params.actorUserId,
      actorRole: String(params.actorRole),
      actionType: params.actionType,
      targetGymId: params.targetGymId ?? null,
      metadata: params.metadata === undefined ? Prisma.JsonNull : params.metadata,
    },
  });
}
