import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../lib/prisma';
import { BadRequestError, UnauthorizedError } from '../utils/errors';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Store nullable email as normalized lowercase, or null if empty. */
export function normalizeEmailOrNull(email: string | null | undefined): string | null {
  if (email == null) return null;
  const normalized = normalizeEmail(String(email));
  return normalized.length > 0 ? normalized : null;
}

function getGoogleAudiences(): string[] {
  const audiences = [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  ].filter((v): v is string => Boolean(v && v.trim()));

  return [...new Set(audiences.map((v) => v.trim()))];
}

export async function verifyGoogleIdToken(idToken: string) {
  const audiences = getGoogleAudiences();
  if (audiences.length === 0) {
    throw new BadRequestError(
      'Google Sign-In is not configured. Set GOOGLE_WEB_CLIENT_ID on the server.'
    );
  }

  const client = new OAuth2Client(audiences[0]);
  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: audiences,
    });
  } catch {
    throw new UnauthorizedError('Invalid Google token');
  }

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new UnauthorizedError('Google account is missing email');
  }
  if (payload.email_verified === false) {
    throw new UnauthorizedError('Google email is not verified');
  }

  return {
    googleSub: payload.sub,
    email: normalizeEmail(payload.email),
    name: payload.name?.trim() || payload.email.split('@')[0],
    photoUrl: payload.picture ?? null,
  };
}

const gymSelect = { id: true, name: true, slug: true, tenantStatus: true } as const;

async function findMembersByEmail(email: string) {
  const normalized = normalizeEmail(email);
  const members = await prisma.member.findMany({
    where: {
      isActive: true,
      email: { equals: normalized },
      gym: { tenantStatus: 'ACTIVE' },
    },
    include: {
      gym: { select: gymSelect },
      package: { select: { id: true, name: true } },
    },
  });

  // Defensive filter for case/trim differences across collations.
  return members.filter((m) => m.email != null && normalizeEmail(m.email) === normalized);
}

async function findTrainersByEmail(email: string) {
  const normalized = normalizeEmail(email);
  const trainers = await prisma.trainer.findMany({
    where: {
      isActive: true,
      email: { equals: normalized },
      gym: { tenantStatus: 'ACTIVE' },
    },
    include: {
      gym: { select: gymSelect },
    },
  });

  return trainers.filter((t) => t.email != null && normalizeEmail(t.email) === normalized);
}

type LinkedMember = Awaited<ReturnType<typeof findMembersByEmail>>[number];
type LinkedTrainer = Awaited<ReturnType<typeof findTrainersByEmail>>[number];

function mapGym(gym: { id: number; name: string; slug: string | null }) {
  return { id: gym.id, name: gym.name, slug: gym.slug };
}

function mapMemberAccount(member: LinkedMember) {
  return {
    accountType: 'MEMBER' as const,
    id: member.id,
    name: member.name,
    memberNumber: member.legacyMemberId,
    photoUrl: member.photoUrl,
    gym: mapGym(member.gym),
  };
}

function mapTrainerAccount(trainer: LinkedTrainer) {
  return {
    accountType: 'TRAINER' as const,
    id: trainer.id,
    name: trainer.name,
    specialization: trainer.specialization,
    photoUrl: null as string | null,
    gym: mapGym(trainer.gym),
  };
}

function memberSession(member: LinkedMember) {
  return {
    accountType: 'MEMBER' as const,
    tokenVersion: member.mobileTokenVersion,
    linked: true as const,
    profile: {
      id: member.id,
      name: member.name,
      phone: member.phone,
      email: member.email,
      photoUrl: member.photoUrl,
      memberNumber: member.legacyMemberId,
      package: member.package,
      membershipStart: member.membershipStart,
      membershipEnd: member.membershipEnd,
    },
    gym: mapGym(member.gym),
  };
}

function trainerSession(trainer: LinkedTrainer) {
  return {
    accountType: 'TRAINER' as const,
    tokenVersion: trainer.mobileTokenVersion,
    linked: true as const,
    profile: {
      id: trainer.id,
      name: trainer.name,
      phone: trainer.phone,
      email: trainer.email,
      photoUrl: null as string | null,
      specialization: trainer.specialization,
    },
    gym: mapGym(trainer.gym),
  };
}

type SessionResult =
  | { needsGymSelection: false; needsAccountSelection: false; session: ReturnType<typeof memberSession> | ReturnType<typeof trainerSession> | GuestSession }
  | { needsGymSelection: true; needsAccountSelection: false; email: string; gyms: GymPickerItem[] }
  | { needsGymSelection: false; needsAccountSelection: true; email: string; accounts: Array<ReturnType<typeof mapMemberAccount> | ReturnType<typeof mapTrainerAccount>> };

type GuestSession = {
  accountType: 'GUEST';
  tokenVersion: number;
  linked: false;
  profile: { id: number; name: string; phone: null; email: string; photoUrl: string | null };
  gym: null;
};

type GymPickerItem = {
  id: number;
  name: string;
  slug: string | null;
  roles: Array<'MEMBER' | 'TRAINER'>;
};

async function markMemberLogin(memberId: number) {
  await prisma.member.update({
    where: { id: memberId },
    data: { mobileLastLoginAt: new Date() },
  });
}

async function markTrainerLogin(trainerId: number) {
  await prisma.trainer.update({
    where: { id: trainerId },
    data: { mobileLastLoginAt: new Date() },
  });
}

/**
 * Resolve session for accounts at a single gym.
 * Default: TRAINER wins when both MEMBER and TRAINER exist.
 * Multiple trainers, or multiple members with no trainer → needsAccountSelection.
 */
async function resolveForGym(
  email: string,
  members: LinkedMember[],
  trainers: LinkedTrainer[]
): Promise<SessionResult> {
  if (members.length === 0 && trainers.length === 0) {
    throw new UnauthorizedError('No active account found for this gym');
  }

  if (trainers.length > 1) {
    return {
      needsGymSelection: false,
      needsAccountSelection: true,
      email,
      accounts: [...trainers.map(mapTrainerAccount), ...members.map(mapMemberAccount)],
    };
  }

  // Prefer TRAINER when both roles exist at the same gym.
  if (trainers.length === 1) {
    await markTrainerLogin(trainers[0].id);
    return {
      needsGymSelection: false,
      needsAccountSelection: false,
      session: trainerSession(trainers[0]),
    };
  }

  if (members.length === 1) {
    await markMemberLogin(members[0].id);
    return {
      needsGymSelection: false,
      needsAccountSelection: false,
      session: memberSession(members[0]),
    };
  }

  return {
    needsGymSelection: false,
    needsAccountSelection: true,
    email,
    accounts: members.map(mapMemberAccount),
  };
}

function buildGymPicker(
  members: LinkedMember[],
  trainers: LinkedTrainer[]
): GymPickerItem[] {
  const byGym = new Map<
    number,
    { id: number; name: string; slug: string | null; roles: Set<'MEMBER' | 'TRAINER'> }
  >();

  for (const m of members) {
    const existing = byGym.get(m.gymId);
    if (existing) {
      existing.roles.add('MEMBER');
    } else {
      byGym.set(m.gymId, {
        id: m.gym.id,
        name: m.gym.name,
        slug: m.gym.slug,
        roles: new Set(['MEMBER']),
      });
    }
  }

  for (const t of trainers) {
    const existing = byGym.get(t.gymId);
    if (existing) {
      existing.roles.add('TRAINER');
    } else {
      byGym.set(t.gymId, {
        id: t.gym.id,
        name: t.gym.name,
        slug: t.gym.slug,
        roles: new Set(['TRAINER']),
      });
    }
  }

  return [...byGym.values()]
    .map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      roles: [...g.roles].sort() as Array<'MEMBER' | 'TRAINER'>,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function upsertGuestUser(input: {
  googleSub: string;
  email: string;
  name: string;
  photoUrl: string | null;
}) {
  const existing = await prisma.mobileGoogleUser.findUnique({
    where: { googleSub: input.googleSub },
  });

  if (existing) {
    return prisma.mobileGoogleUser.update({
      where: { id: existing.id },
      data: {
        email: input.email,
        name: input.name,
        photoUrl: input.photoUrl,
        lastLoginAt: new Date(),
      },
    });
  }

  const byEmail = await prisma.mobileGoogleUser.findUnique({
    where: { email: input.email },
  });
  if (byEmail) {
    return prisma.mobileGoogleUser.update({
      where: { id: byEmail.id },
      data: {
        googleSub: input.googleSub,
        name: input.name,
        photoUrl: input.photoUrl,
        lastLoginAt: new Date(),
      },
    });
  }

  return prisma.mobileGoogleUser.create({
    data: {
      googleSub: input.googleSub,
      email: input.email,
      name: input.name,
      photoUrl: input.photoUrl,
      lastLoginAt: new Date(),
    },
  });
}

async function resolveEmailLogin(
  email: string,
  guestIdentity?: { googleSub: string; name: string; photoUrl: string | null }
): Promise<SessionResult> {
  const [members, trainers] = await Promise.all([
    findMembersByEmail(email),
    findTrainersByEmail(email),
  ]);

  if (members.length === 0 && trainers.length === 0) {
    const guest = await upsertGuestUser({
      googleSub: guestIdentity?.googleSub ?? `dev:${email}`,
      email,
      name: guestIdentity?.name ?? email.split('@')[0],
      photoUrl: guestIdentity?.photoUrl ?? null,
    });
    return {
      needsGymSelection: false,
      needsAccountSelection: false,
      session: {
        accountType: 'GUEST',
        tokenVersion: guest.tokenVersion,
        linked: false,
        profile: {
          id: guest.id,
          name: guest.name,
          phone: null,
          email: guest.email,
          photoUrl: guest.photoUrl,
        },
        gym: null,
      },
    };
  }

  const gyms = buildGymPicker(members, trainers);
  if (gyms.length > 1) {
    return {
      needsGymSelection: true,
      needsAccountSelection: false,
      email,
      gyms,
    };
  }

  const gymId = gyms[0].id;
  return resolveForGym(
    email,
    members.filter((m) => m.gymId === gymId),
    trainers.filter((t) => t.gymId === gymId)
  );
}

async function resolveGymSelection(
  email: string,
  gymId: number
): Promise<SessionResult> {
  const [members, trainers] = await Promise.all([
    findMembersByEmail(email),
    findTrainersByEmail(email),
  ]);

  const gymMembers = members.filter((m) => m.gymId === gymId);
  const gymTrainers = trainers.filter((t) => t.gymId === gymId);

  if (gymMembers.length === 0 && gymTrainers.length === 0) {
    throw new UnauthorizedError('No active account found for this gym');
  }

  return resolveForGym(email, gymMembers, gymTrainers);
}

async function resolveAccountSelection(
  email: string,
  accountType: 'MEMBER' | 'TRAINER',
  accountId: number
) {
  if (accountType === 'MEMBER') {
    const members = await findMembersByEmail(email);
    const member = members.find((m) => m.id === accountId);
    if (!member) {
      throw new UnauthorizedError('Selected account is not linked to this email');
    }
    await markMemberLogin(member.id);
    return memberSession(member);
  }

  const trainers = await findTrainersByEmail(email);
  const trainer = trainers.find((t) => t.id === accountId);
  if (!trainer) {
    throw new UnauthorizedError('Selected account is not linked to this email');
  }
  await markTrainerLogin(trainer.id);
  return trainerSession(trainer);
}

export async function loginWithGoogleIdToken(idToken: string): Promise<SessionResult> {
  const google = await verifyGoogleIdToken(idToken);
  return resolveEmailLogin(google.email, {
    googleSub: google.googleSub,
    name: google.name,
    photoUrl: google.photoUrl,
  });
}

export async function selectGoogleGym(idToken: string, gymId: number): Promise<SessionResult> {
  const google = await verifyGoogleIdToken(idToken);
  return resolveGymSelection(google.email, gymId);
}

export async function selectGoogleAccount(
  idToken: string,
  accountType: 'MEMBER' | 'TRAINER',
  accountId: number
) {
  const google = await verifyGoogleIdToken(idToken);
  return resolveAccountSelection(google.email, accountType, accountId);
}

/** @deprecated Use selectGoogleAccount — kept name alias for clarity in routes. */
export async function selectGoogleMemberAccount(
  idToken: string,
  accountId: number,
  accountType: 'MEMBER' | 'TRAINER' = 'MEMBER'
) {
  return selectGoogleAccount(idToken, accountType, accountId);
}

export function isDevLoginEnabled(): boolean {
  return process.env.MOBILE_DEV_LOGIN_ENABLED === 'true';
}

/**
 * TEMPORARY: signs in by email without a Google token so the app can be tested
 * in Expo Go (native Google Sign-In needs a dev/release build).
 * Only active when MOBILE_DEV_LOGIN_ENABLED=true.
 */
export async function loginWithDevEmail(
  rawEmail: string,
  options?: {
    gymId?: number;
    accountType?: 'MEMBER' | 'TRAINER';
    accountId?: number;
  }
): Promise<SessionResult> {
  if (!isDevLoginEnabled()) {
    throw new UnauthorizedError('Dev login is disabled');
  }

  const email = normalizeEmail(rawEmail);

  if (options?.accountType && options.accountId) {
    const session = await resolveAccountSelection(email, options.accountType, options.accountId);
    return {
      needsGymSelection: false,
      needsAccountSelection: false,
      session,
    };
  }

  if (options?.gymId) {
    return resolveGymSelection(email, options.gymId);
  }

  return resolveEmailLogin(email);
}

/**
 * TEMPORARY companion to {@link loginWithDevEmail} for account picker.
 */
export async function selectDevMemberAccount(
  rawEmail: string,
  accountId: number,
  accountType: 'MEMBER' | 'TRAINER' = 'MEMBER'
) {
  if (!isDevLoginEnabled()) {
    throw new UnauthorizedError('Dev login is disabled');
  }

  return resolveAccountSelection(normalizeEmail(rawEmail), accountType, accountId);
}

export async function logoutGoogleGuest(googleUserId: number) {
  await prisma.mobileGoogleUser.update({
    where: { id: googleUserId },
    data: { tokenVersion: { increment: 1 } },
  });
}
