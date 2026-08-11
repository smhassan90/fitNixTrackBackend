import { prisma } from '../lib/prisma';
import { markOverduePayments } from './paymentService';
import { getOverduePaymentMemberIds } from './attendancePolicyService';

export type DeviceAccessBlockReason = 'overdue' | 'inactive';

export type DeviceAccessTarget = {
  deviceUserId: string;
  memberId: number;
  memberName: string;
  deviceUserName: string | null;
};

export type DeviceAccessBlockedTarget = DeviceAccessTarget & {
  reason: DeviceAccessBlockReason;
};

export type DeviceAccessControlPayload = {
  deviceConfigId: number;
  gymId: number;
  blocked: DeviceAccessBlockedTarget[];
  allowed: DeviceAccessTarget[];
  /** Hint for tablet/device: Access Group numbers used by termux_sync.py */
  groups: {
    active: string;
    blocked: string;
  };
};

/**
 * Mapped device users that should be blocked (overdue or inactive) vs allowed.
 * `deviceUserId` is the ZKTeco uid string stored on DeviceUserMapping.
 */
export async function getDeviceAccessControlTargets(
  gymId: number,
  deviceConfigId: number,
  options?: { activeGroup?: string; blockedGroup?: string }
): Promise<DeviceAccessControlPayload> {
  await markOverduePayments(gymId);

  const mappings = await prisma.deviceUserMapping.findMany({
    where: { deviceConfigId, isActive: true },
    select: {
      deviceUserId: true,
      deviceUserName: true,
      memberId: true,
      member: { select: { id: true, name: true, isActive: true } },
    },
  });

  const memberIds = mappings.map((m) => m.memberId);
  const overdueIds = await getOverduePaymentMemberIds(gymId, memberIds);

  const blocked: DeviceAccessBlockedTarget[] = [];
  const allowed: DeviceAccessTarget[] = [];

  for (const mapping of mappings) {
    const base: DeviceAccessTarget = {
      deviceUserId: mapping.deviceUserId,
      memberId: mapping.memberId,
      memberName: mapping.member.name,
      deviceUserName: mapping.deviceUserName,
    };

    if (!mapping.member.isActive) {
      blocked.push({ ...base, reason: 'inactive' });
    } else if (overdueIds.has(mapping.memberId)) {
      blocked.push({ ...base, reason: 'overdue' });
    } else {
      allowed.push(base);
    }
  }

  blocked.sort((a, b) => a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true }));
  allowed.sort((a, b) => a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true }));

  return {
    deviceConfigId,
    gymId,
    blocked,
    allowed,
    groups: {
      active: options?.activeGroup ?? '1',
      blocked: options?.blockedGroup ?? '2',
    },
  };
}
