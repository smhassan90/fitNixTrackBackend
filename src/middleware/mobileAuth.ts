import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { MobileAccountType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { UnauthorizedError, ForbiddenError, ConflictError, AppError } from '../utils/errors';
import { sendError } from '../utils/response';
import { normalizeEmailOrNull } from '../services/mobileGoogleAuthService';
import { normalizePhone, phonesMatch } from '../utils/phoneNormalize';

export type MobileSessionAccountType = MobileAccountType | 'GUEST';

export interface MobileAuthRequest extends Request {
  mobileUser?: {
    gymId: number | null;
    accountType: MobileSessionAccountType;
    memberId?: number;
    trainerId?: number;
    googleUserId?: number;
    name: string;
    phone: string | null;
    email?: string | null;
    photoUrl?: string | null;
    heightCm?: number | null;
    linked: boolean;
    sessionSubject?: {
      kind: 'google' | 'member' | 'trainer';
      googleUserId?: number;
      memberId?: number;
      trainerId?: number;
    };
  };
}

type MobileJwtPayload = {
  principal?: string;
  gymId?: number | null;
  accountType?: MobileSessionAccountType;
  memberId?: number;
  trainerId?: number;
  googleUserId?: number;
  name?: string;
  phone?: string | null;
  email?: string | null;
  tokenVersion?: number;
};

type LiveMember = {
  id: number;
  gymId: number;
  name: string;
  phone: string | null;
  email: string | null;
  photoUrl: string | null;
  heightCm: number | null;
  isActive: boolean;
  mobileTokenVersion: number;
  gym: { tenantStatus: string };
};

type LiveTrainer = {
  id: number;
  gymId: number;
  name: string;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  mobileTokenVersion: number;
  gym: { tenantStatus: string };
};

type LiveGuest = {
  id: number;
  name: string;
  email: string;
  photoUrl: string | null;
  tokenVersion: number;
};

function mapMemberToMobileUser(
  member: LiveMember,
  options?: { googleUserId?: number }
): NonNullable<MobileAuthRequest['mobileUser']> {
  return {
    gymId: member.gymId,
    accountType: 'MEMBER',
    memberId: member.id,
    googleUserId: options?.googleUserId,
    name: member.name,
    phone: member.phone,
    email: member.email,
    photoUrl: member.photoUrl,
    heightCm: member.heightCm,
    linked: true,
    sessionSubject: options?.googleUserId
      ? { kind: 'google', googleUserId: options.googleUserId }
      : { kind: 'member', memberId: member.id },
  };
}

function mapTrainerToMobileUser(
  trainer: LiveTrainer,
  options?: { googleUserId?: number }
): NonNullable<MobileAuthRequest['mobileUser']> {
  return {
    gymId: trainer.gymId,
    accountType: 'TRAINER',
    trainerId: trainer.id,
    googleUserId: options?.googleUserId,
    name: trainer.name,
    phone: trainer.phone,
    email: trainer.email,
    linked: true,
    sessionSubject: options?.googleUserId
      ? { kind: 'google', googleUserId: options.googleUserId }
      : { kind: 'trainer', trainerId: trainer.id },
  };
}

function mapGuestToMobileUser(guest: LiveGuest): NonNullable<MobileAuthRequest['mobileUser']> {
  return {
    gymId: null,
    accountType: 'GUEST',
    googleUserId: guest.id,
    name: guest.name,
    phone: null,
    email: guest.email,
    photoUrl: guest.photoUrl,
    linked: false,
    sessionSubject: { kind: 'google', googleUserId: guest.id },
  };
}

async function loadGuestById(googleUserId: number): Promise<LiveGuest | null> {
  return prisma.mobileGoogleUser.findUnique({
    where: { id: googleUserId },
    select: {
      id: true,
      name: true,
      email: true,
      photoUrl: true,
      tokenVersion: true,
    },
  });
}

async function loadMemberById(gymId: number, memberId: number): Promise<LiveMember | null> {
  return prisma.member.findFirst({
    where: { id: memberId, gymId },
    select: {
      id: true,
      gymId: true,
      name: true,
      phone: true,
      email: true,
      photoUrl: true,
      heightCm: true,
      isActive: true,
      mobileTokenVersion: true,
      gym: { select: { tenantStatus: true } },
    },
  });
}

async function loadTrainerById(gymId: number, trainerId: number): Promise<LiveTrainer | null> {
  return prisma.trainer.findFirst({
    where: { id: trainerId, gymId },
    select: {
      id: true,
      gymId: true,
      name: true,
      phone: true,
      email: true,
      isActive: true,
      mobileTokenVersion: true,
      gym: { select: { tenantStatus: true } },
    },
  });
}

async function resolveLiveLinkedAccountByIdentity(input: {
  email?: string | null;
  phone?: string | null;
  googleUserId?: number;
}): Promise<NonNullable<MobileAuthRequest['mobileUser']> | null> {
  const normalizedEmail = normalizeEmailOrNull(input.email);
  const normalizedPhone = input.phone ? normalizePhone(input.phone) : null;

  const [emailMembers, emailTrainers, phoneMembers, phoneTrainers] = await Promise.all([
    normalizedEmail
      ? prisma.member.findMany({
          where: {
            isActive: true,
            email: { equals: normalizedEmail },
            gym: { tenantStatus: 'ACTIVE' },
          },
          select: {
            id: true,
            gymId: true,
            name: true,
            phone: true,
            email: true,
            photoUrl: true,
            heightCm: true,
            isActive: true,
            mobileTokenVersion: true,
            gym: { select: { tenantStatus: true } },
          },
        })
      : Promise.resolve([] as LiveMember[]),
    normalizedEmail
      ? prisma.trainer.findMany({
          where: {
            isActive: true,
            email: { equals: normalizedEmail },
            gym: { tenantStatus: 'ACTIVE' },
          },
          select: {
            id: true,
            gymId: true,
            name: true,
            phone: true,
            email: true,
            isActive: true,
            mobileTokenVersion: true,
            gym: { select: { tenantStatus: true } },
          },
        })
      : Promise.resolve([] as LiveTrainer[]),
    normalizedPhone
      ? prisma.member.findMany({
          where: {
            isActive: true,
            phone: { not: null },
            gym: { tenantStatus: 'ACTIVE' },
          },
          select: {
            id: true,
            gymId: true,
            name: true,
            phone: true,
            email: true,
            photoUrl: true,
            heightCm: true,
            isActive: true,
            mobileTokenVersion: true,
            gym: { select: { tenantStatus: true } },
          },
        })
      : Promise.resolve([] as LiveMember[]),
    normalizedPhone
      ? prisma.trainer.findMany({
          where: {
            isActive: true,
            phone: { not: null },
            gym: { tenantStatus: 'ACTIVE' },
          },
          select: {
            id: true,
            gymId: true,
            name: true,
            phone: true,
            email: true,
            isActive: true,
            mobileTokenVersion: true,
            gym: { select: { tenantStatus: true } },
          },
        })
      : Promise.resolve([] as LiveTrainer[]),
  ]);

  const membersByEmail = emailMembers.filter(
    (member) => member.email != null && normalizeEmailOrNull(member.email) === normalizedEmail
  );
  const trainersByEmail = emailTrainers.filter(
    (trainer) => trainer.email != null && normalizeEmailOrNull(trainer.email) === normalizedEmail
  );
  const membersByPhone = normalizedPhone
    ? phoneMembers.filter((member) => phonesMatch(member.phone, normalizedPhone))
    : [];
  const trainersByPhone = normalizedPhone
    ? phoneTrainers.filter((trainer) => phonesMatch(trainer.phone, normalizedPhone))
    : [];

  if (
    normalizedEmail &&
    normalizedPhone &&
    (
      (membersByEmail.length > 0 && membersByPhone.length > 0 && !membersByEmail.some((m) => membersByPhone.some((p) => p.id === m.id))) ||
      (trainersByEmail.length > 0 && trainersByPhone.length > 0 && !trainersByEmail.some((t) => trainersByPhone.some((p) => p.id === t.id)))
    )
  ) {
    throw new ConflictError(
      'Session identity matches different active accounts by email and phone. Please sign in again to resolve the conflict.'
    );
  }

  const memberMap = new Map<number, LiveMember>();
  for (const member of [...membersByEmail, ...membersByPhone]) {
    memberMap.set(member.id, member);
  }
  const trainerMap = new Map<number, LiveTrainer>();
  for (const trainer of [...trainersByEmail, ...trainersByPhone]) {
    trainerMap.set(trainer.id, trainer);
  }

  const members = [...memberMap.values()];
  const trainers = [...trainerMap.values()];

  if (members.length === 0 && trainers.length === 0) {
    return null;
  }

  const gymIds = new Set<number>([
    ...members.map((member) => member.gymId),
    ...trainers.map((trainer) => trainer.gymId),
  ]);

  if (gymIds.size > 1) {
    throw new ConflictError(
      'Multiple active gym accounts match this mobile identity. Please sign in again and choose the correct gym/account.'
    );
  }

  if (trainers.length > 1) {
    throw new ConflictError(
      'Multiple trainer accounts match this mobile identity. Please sign in again and choose the correct account.'
    );
  }

  if (trainers.length === 1) {
    return mapTrainerToMobileUser(trainers[0], { googleUserId: input.googleUserId });
  }

  if (members.length > 1) {
    throw new ConflictError(
      'Multiple member accounts match this mobile identity. Please sign in again and choose the correct account.'
    );
  }

  return mapMemberToMobileUser(members[0], { googleUserId: input.googleUserId });
}

export function authenticateMobileToken(
  req: MobileAuthRequest,
  res: Response,
  next: NextFunction
): void {
  void (async () => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      sendError(res, new UnauthorizedError('No token provided'));
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      sendError(res, new UnauthorizedError('JWT secret not configured'));
      return;
    }

    try {
      const decoded = jwt.verify(token, jwtSecret) as MobileJwtPayload;

      if (decoded.principal !== 'mobile') {
        sendError(res, new UnauthorizedError('Invalid mobile session token'));
        return;
      }

      if (decoded.googleUserId) {
        const guest = await loadGuestById(decoded.googleUserId);
        if (!guest) {
          sendError(res, new UnauthorizedError('Invalid guest session'));
          return;
        }
        if (
          decoded.tokenVersion !== undefined &&
          decoded.tokenVersion !== guest.tokenVersion
        ) {
          sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
          return;
        }
        req.mobileUser =
          (await resolveLiveLinkedAccountByIdentity({
            email: guest.email,
            googleUserId: guest.id,
          })) ?? mapGuestToMobileUser(guest);
        next();
        return;
      }

      if (!decoded.accountType) {
        sendError(res, new UnauthorizedError('Invalid token'));
        return;
      }

      if (decoded.accountType === 'MEMBER') {
        if (!decoded.gymId || !decoded.memberId) {
          sendError(res, new UnauthorizedError('Invalid token'));
          return;
        }
        const member = await loadMemberById(decoded.gymId, decoded.memberId);
        if (!member || !member.isActive) {
          sendError(res, new ForbiddenError('Member account is inactive.'));
          return;
        }
        if (member.gym.tenantStatus === 'SUSPENDED') {
          sendError(res, new ForbiddenError('This gym account is suspended.'));
          return;
        }
        if (
          decoded.tokenVersion !== undefined &&
          decoded.tokenVersion !== member.mobileTokenVersion
        ) {
          sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
          return;
        }
        req.mobileUser = mapMemberToMobileUser(member);
      } else if (decoded.accountType === 'TRAINER') {
        if (!decoded.gymId || !decoded.trainerId) {
          sendError(res, new UnauthorizedError('Invalid token'));
          return;
        }
        const trainer = await loadTrainerById(decoded.gymId, decoded.trainerId);
        if (!trainer || !trainer.isActive) {
          sendError(res, new ForbiddenError('Trainer account is inactive.'));
          return;
        }
        if (trainer.gym.tenantStatus === 'SUSPENDED') {
          sendError(res, new ForbiddenError('This gym account is suspended.'));
          return;
        }
        if (
          decoded.tokenVersion !== undefined &&
          decoded.tokenVersion !== trainer.mobileTokenVersion
        ) {
          sendError(res, new UnauthorizedError('Session expired. Please sign in again.'));
          return;
        }
        req.mobileUser = mapTrainerToMobileUser(trainer);
      } else {
        sendError(res, new UnauthorizedError('Invalid token'));
        return;
      }

      next();
    } catch (error) {
      if (error instanceof AppError) {
        sendError(res, error);
        return;
      }
      sendError(res, new UnauthorizedError('Invalid or expired token'));
    }
  })();
}

export function requireTrainer(req: MobileAuthRequest, res: Response, next: NextFunction): void {
  if (!req.mobileUser) {
    sendError(res, new UnauthorizedError('Authentication required'));
    return;
  }
  if (req.mobileUser.accountType !== 'TRAINER') {
    sendError(res, new ForbiddenError('Trainer access required'));
    return;
  }
  next();
}

export function requireMember(req: MobileAuthRequest, res: Response, next: NextFunction): void {
  if (!req.mobileUser) {
    sendError(res, new UnauthorizedError('Authentication required'));
    return;
  }
  if (req.mobileUser.accountType !== 'MEMBER' || !req.mobileUser.memberId || !req.mobileUser.linked) {
    sendError(res, new ForbiddenError('Member access required'));
    return;
  }
  next();
}

export function requireGymLinked(req: MobileAuthRequest, res: Response, next: NextFunction): void {
  if (!req.mobileUser) {
    sendError(res, new UnauthorizedError('Authentication required'));
    return;
  }
  if (req.mobileUser.accountType === 'GUEST' || !req.mobileUser.linked) {
    sendError(
      res,
      new ForbiddenError(
        'This feature is available only for gym members linked by Gmail on their profile.'
      )
    );
    return;
  }
  next();
}
