import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { MobileAccountType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../utils/errors';
import { normalizePhone, phonesMatch } from '../utils/phoneNormalize';
import { isWhatsAppOtpEnabled, sendWhatsAppOtp } from './whatsappOtpService';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function generateOtp(): string {
  if (process.env.MOBILE_OTP_DEV_CODE) {
    return process.env.MOBILE_OTP_DEV_CODE;
  }
  if (process.env.NODE_ENV !== 'production' && !isWhatsAppOtpEnabled()) {
    return '123456';
  }
  return String(crypto.randomInt(100000, 999999));
}

function allowDevOtpInResponse(): boolean {
  if (process.env.MOBILE_OTP_EXPOSE_DEV_CODE === 'true') return true;
  return process.env.NODE_ENV !== 'production' && !isWhatsAppOtpEnabled();
}

async function resolveGym(gymSlug?: string, gymId?: number) {
  if (gymId) {
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: { id: true, name: true, slug: true, tenantStatus: true },
    });
    if (!gym) throw new NotFoundError('Gym', gymId);
    if (gym.tenantStatus === 'SUSPENDED') {
      throw new BadRequestError('This gym is currently unavailable.');
    }
    return gym;
  }
  if (gymSlug) {
    const gym = await prisma.gym.findFirst({
      where: { slug: gymSlug.trim().toLowerCase() },
      select: { id: true, name: true, slug: true, tenantStatus: true },
    });
    if (!gym) throw new NotFoundError('Gym');
    if (gym.tenantStatus === 'SUSPENDED') {
      throw new BadRequestError('This gym is currently unavailable.');
    }
    return gym;
  }
  throw new BadRequestError('gymSlug or gymId is required');
}

async function findAccountsByPhone(gymId: number, phone: string) {
  const normalized = normalizePhone(phone);
  const [members, trainers] = await Promise.all([
    prisma.member.findMany({
      where: { gymId, isActive: true, phone: { not: null } },
      select: {
        id: true,
        name: true,
        phone: true,
        legacyMemberId: true,
        photoUrl: true,
      },
    }),
    prisma.trainer.findMany({
      where: { gymId, isActive: true, phone: { not: null } },
      select: { id: true, name: true, phone: true, email: true, specialization: true },
    }),
  ]);

  const matchedMembers = members.filter((m) => phonesMatch(m.phone, normalized));
  const matchedTrainers = trainers.filter((t) => phonesMatch(t.phone, normalized));

  return { matchedMembers, matchedTrainers };
}

export async function requestMobileOtp(input: {
  phone: string;
  gymSlug?: string;
  gymId?: number;
}) {
  const gym = await resolveGym(input.gymSlug, input.gymId);
  const { matchedMembers, matchedTrainers } = await findAccountsByPhone(gym.id, input.phone);

  if (matchedMembers.length === 0 && matchedTrainers.length === 0) {
    throw new NotFoundError(
      'Account',
      undefined,
      { message: 'No member or trainer found with this phone number at this gym.' }
    );
  }

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const phoneKey = normalizePhone(input.phone);

  await prisma.mobileOtpSession.deleteMany({
    where: { gymId: gym.id, phone: phoneKey },
  });

  await prisma.mobileOtpSession.create({
    data: {
      gymId: gym.id,
      phone: phoneKey,
      otpHash,
      expiresAt,
    },
  });

  let deliveryChannel: 'whatsapp' | 'dev' = 'dev';
  let deliveredTo: string | null = null;

  if (isWhatsAppOtpEnabled()) {
    // One authentication WhatsApp message per OTP request (login only).
    const sent = await sendWhatsAppOtp(input.phone, otp);
    deliveryChannel = 'whatsapp';
    deliveredTo = sent.to;
  } else if (process.env.NODE_ENV === 'production') {
    await prisma.mobileOtpSession.deleteMany({
      where: { gymId: gym.id, phone: phoneKey },
    });
    throw new BadRequestError(
      'OTP delivery is not configured. Configure WhatsApp Cloud API env vars to send login codes.'
    );
  } else {
    console.info(`[Mobile OTP][dev] gym=${gym.slug ?? gym.id} phone=${input.phone} otp=${otp}`);
  }

  return {
    gym: { id: gym.id, name: gym.name, slug: gym.slug },
    accounts: [
      ...matchedMembers.map((m) => ({
        accountType: 'MEMBER' as MobileAccountType,
        id: m.id,
        name: m.name,
        memberNumber: m.legacyMemberId,
        photoUrl: m.photoUrl,
      })),
      ...matchedTrainers.map((t) => ({
        accountType: 'TRAINER' as MobileAccountType,
        id: t.id,
        name: t.name,
        email: t.email,
        specialization: t.specialization,
      })),
    ],
    otpSent: true,
    channel: deliveryChannel,
    deliveredTo,
    expiresInSeconds: OTP_TTL_MS / 1000,
    ...(allowDevOtpInResponse() && { devOtp: otp }),
  };
}

export async function verifyMobileOtp(input: {
  phone: string;
  otp: string;
  gymSlug?: string;
  gymId?: number;
  accountType: MobileAccountType;
  accountId: number;
}) {
  const gym = await resolveGym(input.gymSlug, input.gymId);
  const phoneKey = normalizePhone(input.phone);

  const session = await prisma.mobileOtpSession.findFirst({
    where: { gymId: gym.id, phone: phoneKey },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) {
    throw new UnauthorizedError('OTP expired or not requested. Please request a new code.');
  }

  if (session.expiresAt < new Date()) {
    await prisma.mobileOtpSession.delete({ where: { id: session.id } });
    throw new UnauthorizedError('OTP expired. Please request a new code.');
  }

  if (session.attempts >= MAX_OTP_ATTEMPTS) {
    throw new UnauthorizedError('Too many failed attempts. Please request a new code.');
  }

  const valid = await bcrypt.compare(input.otp.trim(), session.otpHash);
  if (!valid) {
    await prisma.mobileOtpSession.update({
      where: { id: session.id },
      data: { attempts: { increment: 1 } },
    });
    throw new UnauthorizedError('Invalid OTP');
  }

  await prisma.mobileOtpSession.delete({ where: { id: session.id } });

  if (input.accountType === 'MEMBER') {
    const member = await prisma.member.findFirst({
      where: { id: input.accountId, gymId: gym.id, isActive: true },
      include: { package: { select: { id: true, name: true } } },
    });
    if (!member || !phonesMatch(member.phone, phoneKey)) {
      throw new UnauthorizedError('Invalid member account');
    }
    await prisma.member.update({
      where: { id: member.id },
      data: { mobileLastLoginAt: new Date() },
    });
    return {
      accountType: 'MEMBER' as const,
      tokenVersion: member.mobileTokenVersion,
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
      gym: { id: gym.id, name: gym.name, slug: gym.slug },
    };
  }

  const trainer = await prisma.trainer.findFirst({
    where: { id: input.accountId, gymId: gym.id, isActive: true },
  });
  if (!trainer || !phonesMatch(trainer.phone, phoneKey)) {
    throw new UnauthorizedError('Invalid trainer account');
  }
  await prisma.trainer.update({
    where: { id: trainer.id },
    data: { mobileLastLoginAt: new Date() },
  });
  return {
    accountType: 'TRAINER' as const,
    tokenVersion: trainer.mobileTokenVersion,
    profile: {
      id: trainer.id,
      name: trainer.name,
      phone: trainer.phone,
      email: trainer.email,
      specialization: trainer.specialization,
      startTime: trainer.startTime,
      endTime: trainer.endTime,
    },
    gym: { id: gym.id, name: gym.name, slug: gym.slug },
  };
}

export async function logoutMobileUser(input: {
  accountType: MobileAccountType;
  memberId?: number;
  trainerId?: number;
}) {
  if (input.accountType === 'MEMBER' && input.memberId) {
    await prisma.member.update({
      where: { id: input.memberId },
      data: { mobileTokenVersion: { increment: 1 } },
    });
  } else if (input.accountType === 'TRAINER' && input.trainerId) {
    await prisma.trainer.update({
      where: { id: input.trainerId },
      data: { mobileTokenVersion: { increment: 1 } },
    });
  }
}

export async function lookupGymsByPhone(phone: string) {
  const normalized = normalizePhone(phone);
  const [members, trainers] = await Promise.all([
    prisma.member.findMany({
      where: { isActive: true, phone: { not: null } },
      select: {
        gym: { select: { id: true, name: true, slug: true, tenantStatus: true } },
        phone: true,
      },
    }),
    prisma.trainer.findMany({
      where: { isActive: true, phone: { not: null } },
      select: {
        gym: { select: { id: true, name: true, slug: true, tenantStatus: true } },
        phone: true,
      },
    }),
  ]);

  const gymMap = new Map<number, { id: number; name: string; slug: string | null }>();
  for (const row of [...members, ...trainers]) {
    if (!phonesMatch(row.phone, normalized)) continue;
    if (row.gym.tenantStatus === 'SUSPENDED') continue;
    gymMap.set(row.gym.id, {
      id: row.gym.id,
      name: row.gym.name,
      slug: row.gym.slug,
    });
  }
  return [...gymMap.values()];
}
