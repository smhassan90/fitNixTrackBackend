import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';

export const ownerAdminSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

export type OwnerAdminRow = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
};

export function toOwnerAdminDto(user: OwnerAdminRow) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/** One GYM_ADMIN per gym — same lookup used by GET gym detail and POST create guard. */
export async function findGymOwnerAdmin(gymId: number) {
  const row = await prisma.user.findFirst({
    where: { gymId, role: 'GYM_ADMIN' },
    orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
    select: ownerAdminSelect,
  });
  return row ? toOwnerAdminDto(row) : null;
}

export const OWNER_ADMIN_EXISTS_MESSAGE =
  'This gym already has an owner admin. Use reset password instead of creating a new account.';
