import type { PlatformRole, Prisma } from '@prisma/client';

export type PlatformUserRow = {
  id: number;
  email: string;
  name: string;
  role: PlatformRole;
  isActive: boolean;
  permissionKeys: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
};

export function permissionKeysFromJson(json: Prisma.JsonValue | null | undefined): string[] {
  if (json === null || json === undefined) return [];
  if (!Array.isArray(json)) return [];
  return json.filter((x): x is string => typeof x === 'string');
}

export function toPlatformUserDto(user: PlatformUserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    permissionKeys: permissionKeysFromJson(user.permissionKeys),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}
