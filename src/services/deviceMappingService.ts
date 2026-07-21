import { prisma } from '../lib/prisma';
import {
  calendarDateStringInGymTZ,
  getGymTimezone,
  parseDate,
} from '../utils/dateHelpers';

export function normalizeMemberName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Maps punch identifiers (uid or badge/userSn) → canonical device user uid. */
export type DeviceUserIdentifierMap = Map<string, string>;

/**
 * Build a lookup from any punch identifier to the enrolled user's canonical `deviceUserId` (uid).
 * Attendance logs often carry badge/userSn; user sync stores rows keyed by uid with `deviceBadgeId`.
 */
export async function buildDeviceUserIdentifierMap(
  deviceConfigId: number
): Promise<DeviceUserIdentifierMap> {
  const users = await prisma.deviceUser.findMany({
    where: { deviceConfigId },
    select: { deviceUserId: true, deviceBadgeId: true },
  });

  const map: DeviceUserIdentifierMap = new Map();
  for (const user of users) {
    map.set(user.deviceUserId, user.deviceUserId);
    const badge = user.deviceBadgeId?.trim();
    if (badge) {
      map.set(badge, user.deviceUserId);
    }
  }
  return map;
}

export function resolveCanonicalDeviceUserId(
  map: DeviceUserIdentifierMap,
  rawIdentifier: string
): string {
  const id = rawIdentifier.trim();
  if (!id) return id;
  return map.get(id) ?? id;
}

/**
 * Nameless rows whose `deviceUserId` equals another user's `deviceBadgeId` (attendance-only ghosts).
 */
export function isBadgeGhostDeviceUser(
  user: { deviceUserId: string; deviceUserName: string | null },
  badgeIds: Set<string>
): boolean {
  if (user.deviceUserName?.trim()) return false;
  return badgeIds.has(user.deviceUserId);
}

export function collectDeviceBadgeIds(
  users: Array<{ deviceBadgeId: string | null }>
): Set<string> {
  const badgeIds = new Set<string>();
  for (const user of users) {
    const badge = user.deviceBadgeId?.trim();
    if (badge) badgeIds.add(badge);
  }
  return badgeIds;
}

export async function upsertDeviceUsers(
  deviceConfigId: number,
  users: Array<{
    deviceUserId: string;
    deviceUserName?: string | null;
    deviceBadgeId?: string | null;
  }>
): Promise<number> {
  let upserted = 0;

  for (const user of users) {
    if (!user.deviceUserId) continue;

    await prisma.deviceUser.upsert({
      where: {
        deviceConfigId_deviceUserId: {
          deviceConfigId,
          deviceUserId: user.deviceUserId,
        },
      },
      create: {
        deviceConfigId,
        deviceUserId: user.deviceUserId,
        deviceUserName: user.deviceUserName?.trim() || null,
        deviceBadgeId: user.deviceBadgeId?.trim() || null,
      },
      update: {
        ...(user.deviceUserName !== undefined
          ? { deviceUserName: user.deviceUserName?.trim() || null }
          : {}),
        ...(user.deviceBadgeId !== undefined
          ? { deviceBadgeId: user.deviceBadgeId?.trim() || null }
          : {}),
      },
    });
    upserted++;
  }

  return upserted;
}

export async function ensureDeviceUser(
  deviceConfigId: number,
  deviceUserId: string,
  deviceUserName?: string | null
): Promise<void> {
  await prisma.deviceUser.upsert({
    where: {
      deviceConfigId_deviceUserId: {
        deviceConfigId,
        deviceUserId,
      },
    },
    create: {
      deviceConfigId,
      deviceUserId,
      deviceUserName: deviceUserName?.trim() || null,
    },
    update: deviceUserName
      ? { deviceUserName: deviceUserName.trim() }
      : {},
  });
}

export async function storePendingAttendanceLog(input: {
  gymId: number;
  deviceConfigId: number;
  deviceUserId: string;
  recordTime: Date;
  type?: number | null;
  state?: number | null;
  deviceSerialNumber?: string | null;
}): Promise<boolean> {
  const enrolled = await prisma.deviceUser.findFirst({
    where: {
      deviceConfigId: input.deviceConfigId,
      OR: [
        { deviceUserId: input.deviceUserId },
        { deviceBadgeId: input.deviceUserId },
      ],
    },
    select: { deviceUserId: true, deviceUserName: true },
    orderBy: { deviceUserName: 'desc' },
  });

  const canonicalDeviceUserId = enrolled?.deviceUserId ?? input.deviceUserId;
  await ensureDeviceUser(
    input.deviceConfigId,
    canonicalDeviceUserId,
    enrolled?.deviceUserName
  );

  try {
    await prisma.pendingAttendanceLog.upsert({
      where: {
        deviceConfigId_deviceUserId_recordTime: {
          deviceConfigId: input.deviceConfigId,
          deviceUserId: canonicalDeviceUserId,
          recordTime: input.recordTime,
        },
      },
      create: {
        gymId: input.gymId,
        deviceConfigId: input.deviceConfigId,
        deviceUserId: canonicalDeviceUserId,
        recordTime: input.recordTime,
        type: input.type ?? null,
        state: input.state ?? null,
        deviceSerialNumber: input.deviceSerialNumber ?? null,
      },
      update: {
        type: input.type ?? null,
        state: input.state ?? null,
        deviceSerialNumber: input.deviceSerialNumber ?? null,
      },
    });
    return true;
  } catch (error) {
    console.error('Failed to store pending attendance log:', error);
    return false;
  }
}

/**
 * Apply a single punch to attendance_records for a mapped member.
 */
export async function applyPunchToAttendance(input: {
  gymId: number;
  memberId: number;
  deviceUserId: string;
  logDate: Date;
  type?: number | null;
  state?: number | null;
  deviceSerialNumber?: string | null;
}): Promise<boolean> {
  const { gymId, memberId, deviceUserId, logDate, type, state, deviceSerialNumber } = input;
  // Attendance day = gym calendar day of the punch (not UTC midnight of the instant).
  const dateOnly = parseDate(calendarDateStringInGymTZ(logDate, getGymTimezone()));

  const existingRecord = await prisma.attendanceRecord.findUnique({
    where: {
      gymId_memberId_date: {
        gymId,
        memberId,
        date: dateOnly,
      },
    },
  });

  let isCheckIn: boolean;
  if (type !== undefined && type !== null) {
    isCheckIn = type === 0;
  } else if (state !== undefined && state !== null) {
    isCheckIn = state === 0;
  } else if (!existingRecord || !existingRecord.checkInTime) {
    isCheckIn = true;
  } else if (!existingRecord.checkOutTime) {
    isCheckIn = false;
  } else {
    isCheckIn = logDate < existingRecord.checkInTime;
  }

  if (existingRecord) {
    const updateData: {
      deviceUserId: string;
      deviceSerialNumber?: string;
      status: 'PRESENT';
      checkInTime?: Date;
      checkOutTime?: Date;
    } = {
      deviceUserId,
      deviceSerialNumber: deviceSerialNumber || undefined,
      status: 'PRESENT',
    };

    if (isCheckIn) {
      if (!existingRecord.checkInTime || logDate < existingRecord.checkInTime) {
        updateData.checkInTime = logDate;
      }
    } else {
      if (!existingRecord.checkOutTime || logDate > existingRecord.checkOutTime) {
        updateData.checkOutTime = logDate;
      }
    }

    if ((type === undefined || type === null) && (state === undefined || state === null)) {
      if (!existingRecord.checkInTime) {
        updateData.checkInTime = logDate;
      } else if (!existingRecord.checkOutTime && logDate > existingRecord.checkInTime) {
        updateData.checkOutTime = logDate;
      } else if (existingRecord.checkInTime && logDate < existingRecord.checkInTime) {
        updateData.checkInTime = logDate;
      }
    }

    if (updateData.checkInTime || updateData.checkOutTime) {
      await prisma.attendanceRecord.update({
        where: { id: existingRecord.id },
        data: updateData,
      });
      return true;
    }
    return false;
  }

  await prisma.attendanceRecord.create({
    data: {
      gymId,
      memberId,
      date: dateOnly,
      status: 'PRESENT',
      checkInTime: isCheckIn ? logDate : undefined,
      checkOutTime: !isCheckIn ? logDate : undefined,
      deviceUserId,
      deviceSerialNumber: deviceSerialNumber || undefined,
    },
  });
  return true;
}

/**
 * Move pending punches for a device user into attendance_records after mapping.
 */
export async function processPendingLogsForDeviceUser(
  gymId: number,
  deviceConfigId: number,
  deviceUserId: string,
  memberId: number,
  deviceSerialNumber?: string | null
): Promise<number> {
  const idMap = await buildDeviceUserIdentifierMap(deviceConfigId);
  const canonicalId = resolveCanonicalDeviceUserId(idMap, deviceUserId);
  const deviceUserIds = new Set<string>([canonicalId, deviceUserId.trim()]);
  for (const [alias, canonical] of idMap) {
    if (canonical === canonicalId) {
      deviceUserIds.add(alias);
    }
  }

  const pendingLogs = await prisma.pendingAttendanceLog.findMany({
    where: { deviceConfigId, deviceUserId: { in: [...deviceUserIds] } },
    orderBy: { recordTime: 'asc' },
  });

  let applied = 0;
  for (const log of pendingLogs) {
    const wrote = await applyPunchToAttendance({
      gymId,
      memberId,
      deviceUserId,
      logDate: log.recordTime,
      type: log.type,
      state: log.state,
      deviceSerialNumber: log.deviceSerialNumber ?? deviceSerialNumber,
    });
    if (wrote) applied++;
  }

  if (pendingLogs.length > 0) {
    await prisma.pendingAttendanceLog.deleteMany({
      where: {
        deviceConfigId,
        deviceUserId: { in: [...deviceUserIds] },
      },
    });
  }

  return applied;
}

export interface MappingCandidate {
  deviceUserId: string;
  deviceUserName: string | null;
  /** Alias for deviceUserName — portal/sync UI expects `name` (same as sync-users response). */
  name: string | null;
  deviceBadgeId: string | null;
  pendingLogCount: number;
  /** Exact name match only; still requires explicit confirmation. */
  suggestedMember: { id: number; name: string } | null;
  matchType: 'exact' | null;
}

function toMappingCandidateDto(input: Omit<MappingCandidate, 'name'>): MappingCandidate {
  return {
    ...input,
    name: input.deviceUserName,
  };
}

export async function getMappingCandidates(
  deviceConfigId: number,
  gymId: number
): Promise<{
  unmappedDeviceUsers: MappingCandidate[];
  unmappedMembers: Array<{
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    legacyMemberId: string | null;
    memberNumber: string | null;
  }>;
  mappedCount: number;
  pendingLogCount: number;
}> {
  const [deviceUsers, activeMappings, members, pendingCounts] = await Promise.all([
    prisma.deviceUser.findMany({
      where: { deviceConfigId },
      orderBy: [{ deviceUserName: 'asc' }, { deviceUserId: 'asc' }],
    }),
    prisma.deviceUserMapping.findMany({
      where: { deviceConfigId, isActive: true },
      select: { deviceUserId: true, memberId: true },
    }),
    prisma.member.findMany({
      where: { gymId },
      select: { id: true, legacyMemberId: true, name: true, email: true, phone: true },
      orderBy: { name: 'asc' },
    }),
    prisma.pendingAttendanceLog.groupBy({
      by: ['deviceUserId'],
      where: { deviceConfigId },
      _count: { _all: true },
    }),
  ]);

  const mappedDeviceUserIds = new Set(activeMappings.map((m) => m.deviceUserId));
  const mappedMemberIds = new Set(activeMappings.map((m) => m.memberId));
  const badgeIds = collectDeviceBadgeIds(deviceUsers);
  const deviceUserIdMap = await buildDeviceUserIdentifierMap(deviceConfigId);
  const pendingByUser = new Map<string, number>();
  for (const row of pendingCounts) {
    const canonicalId = resolveCanonicalDeviceUserId(deviceUserIdMap, row.deviceUserId);
    pendingByUser.set(
      canonicalId,
      (pendingByUser.get(canonicalId) || 0) + row._count._all
    );
  }
  const deviceUserById = new Map(deviceUsers.map((u) => [u.deviceUserId, u]));

  const unmappedMembers = members.filter((m) => !mappedMemberIds.has(m.id));

  // Exact-name index: only suggest when exactly one unmapped member matches
  const membersByNormalizedName = new Map<string, typeof unmappedMembers>();
  for (const member of unmappedMembers) {
    const key = normalizeMemberName(member.name);
    if (!key) continue;
    const list = membersByNormalizedName.get(key) || [];
    list.push(member);
    membersByNormalizedName.set(key, list);
  }

  const unmappedDeviceUsers: MappingCandidate[] = deviceUsers
    .filter((u) => !mappedDeviceUserIds.has(u.deviceUserId))
    .filter((u) => !isBadgeGhostDeviceUser(u, badgeIds))
    .map((u) => {
      const pendingLogCount = pendingByUser.get(u.deviceUserId) || 0;
      let suggestedMember: { id: number; name: string } | null = null;
      let matchType: 'exact' | null = null;

      if (u.deviceUserName) {
        const matches = membersByNormalizedName.get(normalizeMemberName(u.deviceUserName));
        if (matches && matches.length === 1) {
          suggestedMember = { id: matches[0].id, name: matches[0].name };
          matchType = 'exact';
        }
      }

      return toMappingCandidateDto({
        deviceUserId: u.deviceUserId,
        deviceUserName: u.deviceUserName,
        deviceBadgeId: u.deviceBadgeId,
        pendingLogCount,
        suggestedMember,
        matchType,
      });
    });

  // Include device users that only appear in pending logs (no DeviceUser row yet)
  for (const [rawDeviceUserId, count] of pendingByUser) {
    const deviceUserId = resolveCanonicalDeviceUserId(deviceUserIdMap, rawDeviceUserId);
    if (mappedDeviceUserIds.has(deviceUserId)) continue;
    if (unmappedDeviceUsers.some((u) => u.deviceUserId === deviceUserId)) continue;
    const du = deviceUserById.get(deviceUserId);
    if (du && isBadgeGhostDeviceUser(du, badgeIds)) continue;
    unmappedDeviceUsers.push(
      toMappingCandidateDto({
        deviceUserId,
        deviceUserName: du?.deviceUserName ?? null,
        deviceBadgeId: du?.deviceBadgeId ?? null,
        pendingLogCount: count,
        suggestedMember: null,
        matchType: null,
      })
    );
  }

  const totalPending = pendingCounts.reduce((sum, row) => sum + row._count._all, 0);

  return {
    unmappedDeviceUsers,
    unmappedMembers: unmappedMembers.map((m) => ({
      ...m,
      memberNumber: m.legacyMemberId?.trim() || null,
    })),
    mappedCount: activeMappings.length,
    pendingLogCount: totalPending,
  };
}

export async function confirmDeviceUserMappings(
  deviceConfigId: number,
  gymId: number,
  mappings: Array<{ deviceUserId: string; memberId: number }>,
  deviceSerialNumber?: string | null
): Promise<{
  mapped: number;
  attendanceSynced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let mapped = 0;
  let attendanceSynced = 0;

  const existingMappings = await prisma.deviceUserMapping.findMany({
    where: { deviceConfigId, isActive: true },
    select: { deviceUserId: true, memberId: true },
  });
  const usedDeviceUserIds = new Set(existingMappings.map((m) => m.deviceUserId));
  const usedMemberIds = new Set(existingMappings.map((m) => m.memberId));

  const members = await prisma.member.findMany({
    where: { gymId, id: { in: mappings.map((m) => m.memberId) } },
    select: { id: true },
  });
  const validMemberIds = new Set(members.map((m) => m.id));

  const deviceUsers = await prisma.deviceUser.findMany({
    where: {
      deviceConfigId,
      deviceUserId: { in: mappings.map((m) => m.deviceUserId) },
    },
  });
  const deviceUserById = new Map(deviceUsers.map((u) => [u.deviceUserId, u]));

  for (const entry of mappings) {
    const { deviceUserId, memberId } = entry;

    if (!deviceUserId || !memberId) {
      errors.push('Each mapping requires deviceUserId and memberId');
      continue;
    }

    if (!validMemberIds.has(memberId)) {
      errors.push(`Member ${memberId} not found in this gym`);
      continue;
    }

    if (usedDeviceUserIds.has(deviceUserId)) {
      errors.push(`Device user ${deviceUserId} is already mapped`);
      continue;
    }

    if (usedMemberIds.has(memberId)) {
      errors.push(`Member ${memberId} is already mapped to another device user`);
      continue;
    }

    const deviceUser = deviceUserById.get(deviceUserId);

    try {
      await prisma.deviceUserMapping.upsert({
        where: {
          deviceConfigId_deviceUserId: {
            deviceConfigId,
            deviceUserId,
          },
        },
        create: {
          deviceConfigId,
          memberId,
          deviceUserId,
          deviceUserName: deviceUser?.deviceUserName ?? null,
          isActive: true,
        },
        update: {
          memberId,
          deviceUserName: deviceUser?.deviceUserName ?? null,
          isActive: true,
        },
      });

      usedDeviceUserIds.add(deviceUserId);
      usedMemberIds.add(memberId);
      mapped++;

      attendanceSynced += await processPendingLogsForDeviceUser(
        gymId,
        deviceConfigId,
        deviceUserId,
        memberId,
        deviceSerialNumber
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Failed to map device user ${deviceUserId}: ${message}`);
    }
  }

  return { mapped, attendanceSynced, errors };
}
