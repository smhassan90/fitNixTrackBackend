import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../lib/prisma';
import { BadRequestError, UnauthorizedError } from '../utils/errors';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

async function verifyGoogleIdToken(idToken: string) {
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

async function findMembersByEmail(email: string) {
  const normalized = normalizeEmail(email);
  const members = await prisma.member.findMany({
    where: {
      isActive: true,
      email: { equals: normalized },
      gym: { tenantStatus: 'ACTIVE' },
    },
    include: {
      gym: { select: { id: true, name: true, slug: true, tenantStatus: true } },
      package: { select: { id: true, name: true } },
    },
  });

  // Defensive filter for case/trim differences across collations.
  return members.filter((m) => m.email != null && normalizeEmail(m.email) === normalized);
}

function mapMemberAccount(member: Awaited<ReturnType<typeof findMembersByEmail>>[number]) {
  return {
    accountType: 'MEMBER' as const,
    id: member.id,
    name: member.name,
    memberNumber: member.legacyMemberId,
    photoUrl: member.photoUrl,
    gym: {
      id: member.gym.id,
      name: member.gym.name,
      slug: member.gym.slug,
    },
  };
}

function memberSession(member: Awaited<ReturnType<typeof findMembersByEmail>>[number]) {
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
    gym: {
      id: member.gym.id,
      name: member.gym.name,
      slug: member.gym.slug,
    },
  };
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

export async function loginWithGoogleIdToken(idToken: string) {
  const google = await verifyGoogleIdToken(idToken);
  const members = await findMembersByEmail(google.email);

  if (members.length === 1) {
    const member = members[0];
    await prisma.member.update({
      where: { id: member.id },
      data: { mobileLastLoginAt: new Date() },
    });
    return {
      needsAccountSelection: false as const,
      session: memberSession(member),
    };
  }

  if (members.length > 1) {
    return {
      needsAccountSelection: true as const,
      email: google.email,
      accounts: members.map(mapMemberAccount),
    };
  }

  const guest = await upsertGuestUser(google);
  return {
    needsAccountSelection: false as const,
    session: {
      accountType: 'GUEST' as const,
      tokenVersion: guest.tokenVersion,
      linked: false as const,
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

export async function selectGoogleMemberAccount(idToken: string, accountId: number) {
  const google = await verifyGoogleIdToken(idToken);
  const members = await findMembersByEmail(google.email);
  const member = members.find((m) => m.id === accountId);
  if (!member) {
    throw new UnauthorizedError('Selected account is not linked to this Google email');
  }

  await prisma.member.update({
    where: { id: member.id },
    data: { mobileLastLoginAt: new Date() },
  });

  return memberSession(member);
}

export async function logoutGoogleGuest(googleUserId: number) {
  await prisma.mobileGoogleUser.update({
    where: { id: googleUserId },
    data: { tokenVersion: { increment: 1 } },
  });
}
