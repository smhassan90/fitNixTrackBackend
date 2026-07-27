import { randomBytes } from 'crypto';
import {
  AccountDeletionAccountType,
  AccountDeletionSource,
  AccountDeletionStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { BadRequestError, NotFoundError, ValidationError } from '../utils/errors';
import { normalizePhone, phonesMatch } from '../utils/phoneNormalize';
import { deleteStoredMemberPhoto } from './memberPhotoService';
import { accountDeletionNotifyTo, sendEmail } from './emailService';

const RECEIVED_MESSAGE =
  'Your deletion request has been received. We will process it within 30 days after verifying your identity.';

function normalizeEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const n = String(email).trim().toLowerCase();
  return n.length > 0 ? n : null;
}

function normalizeOptionalText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t) return null;
  return t.slice(0, max);
}

function newRequestId(): string {
  return `adr_${randomBytes(12).toString('hex')}`;
}

function portalBaseUrl(): string {
  return (
    process.env.PLATFORM_ADMIN_URL?.trim() ||
    process.env.CORS_ORIGIN?.trim() ||
    'https://fitnixtrack.vercel.app'
  ).replace(/\/$/, '');
}

export type CreateDeletionInput = {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  accountType: AccountDeletionAccountType;
  gymName?: string | null;
  reason?: string | null;
  source?: AccountDeletionSource;
  requesterIp?: string | null;
  /** Pre-linked ids when created from an authenticated mobile session. */
  matchedMemberId?: number | null;
  matchedTrainerId?: number | null;
  matchedGymId?: number | null;
};

async function findLikelyMatches(email: string | null, _phone: string | null) {
  const emailNorm = normalizeEmail(email);
  let matchedMemberId: number | null = null;
  let matchedTrainerId: number | null = null;
  let matchedGymId: number | null = null;

  if (emailNorm) {
    const [members, trainers] = await Promise.all([
      prisma.member.findMany({
        where: { email: emailNorm, isActive: true },
        select: { id: true, gymId: true, email: true },
        take: 5,
      }),
      prisma.trainer.findMany({
        where: { email: emailNorm, isActive: true },
        select: { id: true, gymId: true, email: true },
        take: 5,
      }),
    ]);
    const membersExact = members.filter((m) => normalizeEmail(m.email) === emailNorm);
    const trainersExact = trainers.filter((t) => normalizeEmail(t.email) === emailNorm);
    if (membersExact.length === 1) {
      matchedMemberId = membersExact[0].id;
      matchedGymId = membersExact[0].gymId;
    }
    if (trainersExact.length === 1) {
      matchedTrainerId = trainersExact[0].id;
      matchedGymId = matchedGymId ?? trainersExact[0].gymId;
    }
  }

  // Phone auto-match is skipped at create time (collation / formatting variance).
  // Admins set matchedMemberId / matchedTrainerId before marking completed when needed.
  void _phone;

  return { matchedMemberId, matchedTrainerId, matchedGymId };
}

async function notifyAdmins(request: {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  accountType: string;
  gymName: string | null;
  reason: string | null;
  source: string;
  matchedMemberId: number | null;
  matchedTrainerId: number | null;
  matchedGymId: number | null;
}) {
  const adminTo = accountDeletionNotifyTo();
  const text = [
    'New FitNix Track account deletion request',
    '',
    `Request ID: ${request.id}`,
    `Status: pending`,
    `Name: ${request.fullName}`,
    `Email: ${request.email ?? '(none)'}`,
    `Phone: ${request.phone ?? '(none)'}`,
    `Account type: ${request.accountType}`,
    `Gym: ${request.gymName ?? '(none)'}`,
    `Source: ${request.source}`,
    `Reason: ${request.reason ?? '(none)'}`,
    `Matched memberId: ${request.matchedMemberId ?? '(none)'}`,
    `Matched trainerId: ${request.matchedTrainerId ?? '(none)'}`,
    `Matched gymId: ${request.matchedGymId ?? '(none)'}`,
    '',
    `Process in platform admin (filter by id): ${request.id}`,
    `Portal: ${portalBaseUrl()}`,
    '',
    'SLA: complete verified requests within 30 days.',
  ].join('\n');

  await sendEmail({
    to: adminTo,
    subject: `[FitNix] Account deletion request ${request.id}`,
    text,
    replyTo: request.email ?? undefined,
  });
}

async function notifyRequester(email: string | null, requestId: string) {
  if (!email) return;
  await sendEmail({
    to: email,
    subject: 'FitNix Track — account deletion request received',
    text: [
      'We received your FitNix Track account deletion request.',
      '',
      `Reference: ${requestId}`,
      '',
      RECEIVED_MESSAGE,
      '',
      'If you did not submit this request, contact support at dev.fynals@gmail.com.',
    ].join('\n'),
  });
}

export async function createAccountDeletionRequest(input: CreateDeletionInput) {
  const email = normalizeEmail(input.email);
  const phone = normalizeOptionalText(input.phone, 40);
  if (!email && !phone) {
    throw new ValidationError('Provide at least an email or a phone number');
  }

  const fullName = input.fullName.trim().slice(0, 100);
  if (!fullName) throw new ValidationError('Full name is required');

  const hints =
    input.matchedMemberId || input.matchedTrainerId || input.matchedGymId
      ? {
          matchedMemberId: input.matchedMemberId ?? null,
          matchedTrainerId: input.matchedTrainerId ?? null,
          matchedGymId: input.matchedGymId ?? null,
        }
      : await findLikelyMatches(email, phone);

  const id = newRequestId();
  const created = await prisma.accountDeletionRequest.create({
    data: {
      id,
      fullName,
      email,
      phone,
      accountType: input.accountType,
      gymName: normalizeOptionalText(input.gymName, 200),
      reason: normalizeOptionalText(input.reason, 1000),
      source: input.source ?? 'web',
      status: 'pending',
      matchedMemberId: hints.matchedMemberId,
      matchedTrainerId: hints.matchedTrainerId,
      matchedGymId: hints.matchedGymId,
      requesterIp: normalizeOptionalText(input.requesterIp, 64),
    },
  });

  // Fire-and-forget notifications — never fail the HTTP create if email is down.
  void notifyAdmins(created).catch((err) =>
    console.error('[account-deletion] admin notify failed', err)
  );
  void notifyRequester(email, created.id).catch((err) =>
    console.error('[account-deletion] requester notify failed', err)
  );

  return {
    id: created.id,
    status: created.status,
    message: RECEIVED_MESSAGE,
  };
}

export async function listAccountDeletionRequests(query: {
  status?: AccountDeletionStatus;
  page?: number;
  limit?: number;
  search?: string;
}) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 20, 100);
  const search = query.search?.trim();

  const where: {
    status?: AccountDeletionStatus;
    OR?: Array<Record<string, unknown>>;
  } = {};
  if (query.status) where.status = query.status;
  if (search) {
    where.OR = [
      { id: { contains: search } },
      { fullName: { contains: search } },
      { email: { contains: search.toLowerCase() } },
      { phone: { contains: search } },
      { gymName: { contains: search } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.accountDeletionRequest.count({ where }),
    prisma.accountDeletionRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { requests: rows, total, page, limit };
}

export async function getAccountDeletionRequest(id: string) {
  const row = await prisma.accountDeletionRequest.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('AccountDeletionRequest', id);
  return row;
}

async function anonymizeMember(memberId: number) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, photoUrl: true },
  });
  if (!member) return;

  await deleteStoredMemberPhoto(member.photoUrl).catch(() => undefined);

  await prisma.member.update({
    where: { id: memberId },
    data: {
      name: 'Deleted user',
      email: null,
      phone: null,
      photoUrl: null,
      heightCm: null,
      cnic: null,
      comments: null,
      gender: null,
      dateOfBirth: null,
      isActive: false,
      inactiveFrom: new Date(),
      mobileTokenVersion: { increment: 1 },
    },
  });

  await prisma.mobilePushToken.deleteMany({ where: { memberId } });
  await prisma.mobileNotification.deleteMany({ where: { memberId } });
}

async function anonymizeTrainer(trainerId: number) {
  const trainer = await prisma.trainer.findUnique({
    where: { id: trainerId },
    select: { id: true, phone: true },
  });
  if (!trainer) return;

  await prisma.trainer.update({
    where: { id: trainerId },
    data: {
      name: 'Deleted user',
      email: null,
      phone: null,
      gender: null,
      dateOfBirth: null,
      specialization: null,
      isActive: false,
      mobileTokenVersion: { increment: 1 },
    },
  });

  await prisma.mobilePushToken.deleteMany({ where: { trainerId } });
  await prisma.mobileNotification.deleteMany({ where: { trainerId } });
}

async function wipeGuestGoogleUser(email: string | null) {
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) return;

  const guest = await prisma.mobileGoogleUser.findUnique({ where: { email: emailNorm } });
  if (!guest) return;

  // Cascades guest_workout_logs
  await prisma.mobileGoogleUser.delete({ where: { id: guest.id } });
}

async function wipeOtpSessions(phone: string | null) {
  if (!phone) return;
  const key = normalizePhone(phone);
  if (!key) return;
  // OTP rows store normalized phone keys; also try raw
  await prisma.mobileOtpSession.deleteMany({
    where: {
      OR: [{ phone: key }, { phone }],
    },
  });
}

/**
 * Clears app login capability and PII on matched member/trainer/guest.
 * Keeps attendance/payments rows but without direct contact PII on the person record.
 */
export async function processAccountDeletion(requestId: string) {
  const request = await prisma.accountDeletionRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new NotFoundError('AccountDeletionRequest', requestId);

  const memberIds = new Set<number>();
  const trainerIds = new Set<number>();

  if (request.matchedMemberId) memberIds.add(request.matchedMemberId);
  if (request.matchedTrainerId) trainerIds.add(request.matchedTrainerId);

  const emailNorm = normalizeEmail(request.email);
  if (emailNorm) {
    const [members, trainers] = await Promise.all([
      prisma.member.findMany({
        where: { email: emailNorm },
        select: { id: true, email: true },
      }),
      prisma.trainer.findMany({
        where: { email: emailNorm },
        select: { id: true, email: true },
      }),
    ]);
    for (const m of members) {
      if (normalizeEmail(m.email) === emailNorm) memberIds.add(m.id);
    }
    for (const t of trainers) {
      if (normalizeEmail(t.email) === emailNorm) trainerIds.add(t.id);
    }
  }

  // Optional exact phone string match (normalized digits compare in JS on small candidate set).
  if (request.phone) {
    const phoneKey = normalizePhone(request.phone);
    if (phoneKey.length >= 10) {
      const likeTail = phoneKey.slice(-10);
      const [members, trainers] = await Promise.all([
        prisma.member.findMany({
          where: { phone: { contains: likeTail } },
          select: { id: true, phone: true },
          take: 50,
        }),
        prisma.trainer.findMany({
          where: { phone: { contains: likeTail } },
          select: { id: true, phone: true },
          take: 50,
        }),
      ]);
      for (const m of members) {
        if (phonesMatch(m.phone, request.phone)) memberIds.add(m.id);
      }
      for (const t of trainers) {
        if (phonesMatch(t.phone, request.phone)) trainerIds.add(t.id);
      }
    }
  }

  for (const id of memberIds) {
    await anonymizeMember(id);
  }
  for (const id of trainerIds) {
    await anonymizeTrainer(id);
  }

  await wipeGuestGoogleUser(request.email);
  await wipeOtpSessions(request.phone);

  return {
    anonymizedMemberIds: [...memberIds],
    anonymizedTrainerIds: [...trainerIds],
  };
}

export async function updateAccountDeletionRequest(
  id: string,
  input: {
    status?: AccountDeletionStatus;
    processorNotes?: string | null;
    processDeletion?: boolean;
    matchedMemberId?: number | null;
    matchedTrainerId?: number | null;
    matchedGymId?: number | null;
  },
  processor: { platformUserId: number; email: string; name: string }
) {
  const existing = await getAccountDeletionRequest(id);

  if (existing.status === 'completed' && input.status && input.status !== 'completed') {
    throw new BadRequestError('Completed deletion requests cannot change status');
  }

  const nextStatus = input.status ?? existing.status;
  const shouldProcess =
    nextStatus === 'completed' &&
    (input.processDeletion !== false) &&
    existing.status !== 'completed';

  let processResult: Awaited<ReturnType<typeof processAccountDeletion>> | null = null;
  if (shouldProcess) {
    // Persist match overrides before processing
    if (
      input.matchedMemberId !== undefined ||
      input.matchedTrainerId !== undefined ||
      input.matchedGymId !== undefined
    ) {
      await prisma.accountDeletionRequest.update({
        where: { id },
        data: {
          matchedMemberId:
            input.matchedMemberId !== undefined
              ? input.matchedMemberId
              : existing.matchedMemberId,
          matchedTrainerId:
            input.matchedTrainerId !== undefined
              ? input.matchedTrainerId
              : existing.matchedTrainerId,
          matchedGymId:
            input.matchedGymId !== undefined ? input.matchedGymId : existing.matchedGymId,
        },
      });
    }
    processResult = await processAccountDeletion(id);
  }

  const notesParts = [
    input.processorNotes?.trim() || null,
    `Processed by ${processor.name} <${processor.email}> (platformUserId=${processor.platformUserId})`,
    processResult
      ? `Anonymized members=[${processResult.anonymizedMemberIds.join(',')}] trainers=[${processResult.anonymizedTrainerIds.join(',')}]`
      : null,
  ].filter(Boolean);

  const updated = await prisma.accountDeletionRequest.update({
    where: { id },
    data: {
      status: nextStatus,
      processorNotes: notesParts.join('\n') || existing.processorNotes,
      processedByPlatformUserId:
        nextStatus === 'completed' || nextStatus === 'rejected'
          ? processor.platformUserId
          : existing.processedByPlatformUserId,
      processedAt:
        nextStatus === 'completed' || nextStatus === 'rejected'
          ? new Date()
          : existing.processedAt,
      matchedMemberId:
        input.matchedMemberId !== undefined ? input.matchedMemberId : undefined,
      matchedTrainerId:
        input.matchedTrainerId !== undefined ? input.matchedTrainerId : undefined,
      matchedGymId: input.matchedGymId !== undefined ? input.matchedGymId : undefined,
    },
  });

  if (nextStatus === 'completed' && existing.email) {
    void sendEmail({
      to: existing.email,
      subject: 'FitNix Track — account deletion completed',
      text: [
        'Your FitNix Track account deletion request has been completed.',
        '',
        `Reference: ${id}`,
        '',
        'App login for the verified account(s) has been disabled and personal contact details have been removed or anonymized.',
        'Gym business records (e.g. attendance/payments) may be retained without your personal contact details.',
      ].join('\n'),
    }).catch((err) => console.error('[account-deletion] completion email failed', err));
  }

  if (nextStatus === 'rejected' && existing.email) {
    void sendEmail({
      to: existing.email,
      subject: 'FitNix Track — account deletion request update',
      text: [
        'We could not complete your FitNix Track account deletion request.',
        '',
        `Reference: ${id}`,
        input.processorNotes
          ? `Reason: ${input.processorNotes}`
          : 'Reason: We could not verify your identity with the details provided.',
        '',
        'Reply to this email or contact dev.fynals@gmail.com if you need help.',
      ].join('\n'),
    }).catch((err) => console.error('[account-deletion] rejection email failed', err));
  }

  return updated;
}
