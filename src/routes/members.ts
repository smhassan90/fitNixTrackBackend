import { Router, Response } from 'express';
import type { Trainer } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import {
  authenticateToken,
  AuthRequest,
  requireGymPermission,
} from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  createMemberSchema,
  updateMemberSchema,
  getMembersSchema,
  getMemberSchema,
  deleteMemberSchema,
  getMemberPaymentsSchema,
  markMemberMonthPaidSchema,
  deactivateMemberSchema,
  reactivateMemberSchema,
} from '../validations/members';
import {
  assertMemberDiscountWithinLimit,
  resolveMaxMemberDiscount,
} from '../services/memberDiscountPolicy';
import { assertGymCanAddActiveMember } from '../services/planMemberLimitService';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';
import { withMemberNumber } from '../utils/memberPublic';
import {
  allocateNextLegacyMemberId,
  isLegacyMemberIdUniqueViolation,
} from '../utils/memberLookup';
import {
  parseDate,
  installmentDisplayBucket,
  getGymTimezone,
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
} from '../utils/dateHelpers';
import { normalizeEmailOrNull } from '../services/mobileGoogleAuthService';
import {
  formatMemberStatusFields,
  resolveMemberStatusEffectiveDate,
} from '../utils/memberStatus';
import {
  generatePaymentsForMember,
  computeSignupOneTimeFees,
  refreshMemberOpenInstallmentAmounts,
  markOverduePayments,
  markMonthlyInstallmentByYearMonth,
  syncMissingNextMonthlyInstallment,
  ensureMonthlyInstallmentsThroughMonthKey,
  getPendingOneTimeByMemberIds,
  normalizeOneTimePaymentBreakdown,
} from '../services/paymentService';
import { parseMemberPhotoUpload } from '../middleware/memberPhotoMultipart';
import {
  compressMemberPhoto,
  deleteStoredMemberPhoto,
  storeMemberPhoto,
} from '../services/memberPhotoService';

const router = Router();

let memberStatusColumnsAvailableCache: boolean | null = null;
let memberPhotoUrlColumnAvailableCache: boolean | null = null;

async function hasMemberStatusColumns(): Promise<boolean> {
  if (memberStatusColumnsAvailableCache !== null) {
    return memberStatusColumnsAvailableCache;
  }
  try {
    // Probe the real table so we match MySQL’s view of columns (information_schema
    // can miss rows when table name casing / permissions differ).
    await prisma.$queryRawUnsafe(
      'SELECT `isActive`, `inactiveFrom`, `billingResumeFrom` FROM `members` WHERE 1 = 0'
    );
    memberStatusColumnsAvailableCache = true;
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const code =
      typeof e === 'object' && e !== null && 'code' in e
        ? String((e as { code: unknown }).code)
        : '';
    const missingColumn =
      /unknown column/i.test(msg) ||
      /doesn't exist/i.test(msg) ||
      code === 'ER_BAD_FIELD_ERROR';
    if (missingColumn) {
      memberStatusColumnsAvailableCache = false;
      return false;
    }
    // Transient DB errors: do not cache so the next request can re-probe.
    return false;
  }
}

async function ensureMemberStatusColumnsOrThrow(): Promise<void> {
  const available = await hasMemberStatusColumns();
  if (!available) {
    throw new ValidationError(
      'Member status columns are not migrated yet. Please run prisma db push (or production migration) first.'
    );
  }
}

async function hasMemberPhotoUrlColumn(): Promise<boolean> {
  if (memberPhotoUrlColumnAvailableCache !== null) {
    return memberPhotoUrlColumnAvailableCache;
  }
  try {
    await prisma.$queryRawUnsafe('SELECT `photoUrl` FROM `members` WHERE 1 = 0');
    memberPhotoUrlColumnAvailableCache = true;
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const code =
      typeof e === 'object' && e !== null && 'code' in e
        ? String((e as { code: unknown }).code)
        : '';
    const missingColumn =
      /unknown column/i.test(msg) ||
      /doesn't exist/i.test(msg) ||
      code === 'ER_BAD_FIELD_ERROR';
    if (missingColumn) {
      memberPhotoUrlColumnAvailableCache = false;
      return false;
    }
    return false;
  }
}

async function ensureMemberPhotoUrlColumnOrThrow(): Promise<void> {
  const available = await hasMemberPhotoUrlColumn();
  if (!available) {
    throw new ValidationError(
      'Member photoUrl column is not migrated yet. Run prisma migrate deploy or prisma/manual_sql/add_member_photo_url.sql first.'
    );
  }
}

function parseMemberDateOfBirth(input: unknown): Date | null {
  if (input === undefined || input === null || input === '') return null;
  const value = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return parseDate(value);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('dateOfBirth must be YYYY-MM-DD or ISO 8601 datetime stringwhen', [
      {
        path: 'body.dateOfBirth',
        message: 'Expected YYYY-MM-DD or ISO 8601 datetime.',
      },
    ], 422);
  }
  return parsed;
}

function normalizeMemberDobForResponse<T extends { dateOfBirth?: Date | null }>(member: T): T & {
  dateOfBirth: string | null;
} {
  return {
    ...member,
    dateOfBirth: member.dateOfBirth ? new Date(member.dateOfBirth).toISOString() : null,
  };
}

function formatMemberResponse(
  member: {
    dateOfBirth?: Date | null;
    legacyMemberId?: string | null;
    membershipStart?: Date | null;
    inactiveFrom?: Date | null;
    billingResumeFrom?: Date | null;
    isActive?: boolean | null;
    [key: string]: unknown;
  }
) {
  const normalized = normalizeMemberDobForResponse(member);
  const withNumber = withMemberNumber({
    ...normalized,
    legacyMemberId: member.legacyMemberId ?? null,
  });
  return {
    ...withNumber,
    legacyMemberId: withNumber.legacyMemberId ?? withNumber.memberNumber,
    ...formatMemberStatusFields(member),
  };
}

async function assertLegacyMemberIdAvailable(
  gymId: number,
  legacyMemberId: string | null | undefined,
  excludeMemberId?: number
): Promise<void> {
  if (!legacyMemberId) return;

  const existing = await prisma.member.findFirst({
    where: {
      gymId,
      legacyMemberId,
      ...(excludeMemberId != null ? { id: { not: excludeMemberId } } : {}),
    },
    select: { id: true },
  });

  if (existing) {
    throw new ValidationError(
      `Member ID "${legacyMemberId}" is already assigned to another member in this gym`
    );
  }
}

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/members
router.get(
  '/',
  requireGymPermission('gym.members.read'),
  validate(getMembersSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!; 
      const {
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        page,
        limit,
        createdFrom,
        createdTo,
      } = req.query as any;

      // Ensure page and limit are numbers (validation middleware should handle this, but add safeguard)
      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      const where: any = { gymId };

      if (createdFrom || createdTo) {
        if (createdFrom && createdTo && createdFrom > createdTo) {
          sendError(res, new ValidationError('createdFrom must be on or before createdTo'));
          return;
        }
        where.createdAt = {};
        if (createdFrom) {
          where.createdAt.gte = startOfGymCalendarDayUtc(createdFrom);
        }
        if (createdTo) {
          where.createdAt.lt = startOfNextGymCalendarDayUtc(createdTo);
        }
      }

      // Search filter
      if (search) {
        const searchNum = parseInt(search, 10);
        where.OR = [
          { name: { contains: search } },
          { email: { contains: search } },
          { phone: { contains: search } },
          { cnic: { contains: search } },
          { legacyMemberId: { contains: search } },
          // If search is a number, also search by system ID or exact legacy ID
          ...(isNaN(searchNum)
            ? []
            : [{ id: searchNum }, { legacyMemberId: search.trim() }]),
        ];
      }

      // Validate sortBy to prevent SQL injection and ensure it uses indexed fields
      const validSortFields = ['id', 'name', 'createdAt', 'updatedAt', 'membershipStart'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

      // Get total count and members in parallel for better performance
      const statusColsAvailable = await hasMemberStatusColumns();
      const photoUrlAvailable = await hasMemberPhotoUrlColumn();

      const [total, members] = await Promise.all([
        prisma.member.count({ where }),
        prisma.member.findMany({
          where,
          select: {
            id: true,
            legacyMemberId: true,
            gymId: true,
            name: true,
            phone: true,
            email: true,
            gender: true,
            dateOfBirth: true,
            cnic: true,
            comments: true,
            ...(photoUrlAvailable ? { photoUrl: true } : {}),
            packageId: true,
            discount: true,
            membershipStart: true,
            membershipEnd: true,
            ...(statusColsAvailable
              ? {
                  isActive: true,
                  inactiveFrom: true,
                  billingResumeFrom: true,
                }
              : {}),
            admissionFeeWaived: true,
            admissionFeePaid: true,
            oneTimePaymentAmount: true,
            oneTimePaymentPaid: true,
            monthlyPaymentAmount: true,
            createdAt: true,
            updatedAt: true,
            package: {
              select: {
                id: true,
                name: true,
                price: true,
                discount: true,
                duration: true,
                features: true,
              } as any,
            },
            trainers: {
              include: {
                trainer: {
                  select: {
                    id: true,
                    name: true,
                    gender: true,
                    specialization: true,
                    charges: true,
                  },
                },
              },
            },
          },
          orderBy: { [sortField]: sortOrder },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
      ]);

      // Format response with payment summary + gym-facing memberNumber
      const formattedMembers = members.map((member: any) => ({
        ...formatMemberResponse(member),
        trainers: member.trainers.map((mt: any) => mt.trainer),
        paymentSummary: {
          admissionFeeWaived: member.admissionFeeWaived,
          admissionFeePaid: member.admissionFeePaid ?? 0,
          oneTimePaymentAmount: member.oneTimePaymentAmount ?? 0,
          oneTimePaymentPaid: member.oneTimePaymentPaid,
          monthlyPaymentAmount: member.monthlyPaymentAmount ?? 0,
        },
      }));

      sendSuccess(res, {
        members: formattedMembers,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/members/next-member-number — preview next gym member ID (max legacyMemberId + 1)
router.get(
  '/next-member-number',
  requireGymPermission('gym.members.manage'),
  async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;
    const memberNumber = await allocateNextLegacyMemberId(gymId);
    sendSuccess(res, {
      memberNumber,
      legacyMemberId: memberNumber,
    });
  } catch (error) {
    sendError(res, error as Error);
  }
  }
);

// GET /api/members/:id
router.get(
  '/:id',
  requireGymPermission('gym.members.read'),
  validate(getMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      // id is transformed to number by validation middleware
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);

      const statusColsAvailable = await hasMemberStatusColumns();
      const photoUrlAvailable = await hasMemberPhotoUrlColumn();

      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        select: {
          id: true,
          legacyMemberId: true,
          gymId: true,
          name: true,
          phone: true,
          email: true,
          gender: true,
          dateOfBirth: true,
          cnic: true,
          comments: true,
          ...(photoUrlAvailable ? { photoUrl: true } : {}),
          packageId: true,
          discount: true,
          membershipStart: true,
          membershipEnd: true,
          ...(statusColsAvailable
            ? {
                isActive: true,
                inactiveFrom: true,
                billingResumeFrom: true,
              }
            : {}),
          admissionFeeWaived: true,
          admissionFeePaid: true,
          oneTimePaymentAmount: true,
          oneTimePaymentPaid: true,
          monthlyPaymentAmount: true,
          createdAt: true,
          updatedAt: true,
          package: true,
          trainers: {
            include: {
              trainer: true,
            },
          },
          deviceUserMappings: {
            where: { isActive: true },
            include: {
              deviceConfig: {
                select: {
                  id: true,
                  name: true,
                  ipAddress: true,
                },
              },
            },
          },
        },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      // Get one-time payment if exists
      const oneTimePayment = await prisma.oneTimePayment.findFirst({
        where: { memberId: member.id, gymId },
        orderBy: { createdAt: 'desc' },
      });

      sendSuccess(res, {
        ...formatMemberResponse(member as any),
        trainers: member.trainers.map((mt) => mt.trainer),
        deviceMappings: member.deviceUserMappings.map((mapping) => ({
          id: mapping.id,
          deviceUserId: mapping.deviceUserId,
          deviceUserName: mapping.deviceUserName,
          deviceConfig: mapping.deviceConfig,
        })),
        oneTimePayment: oneTimePayment || null,
        paymentSummary: {
          admissionFeeWaived: member.admissionFeeWaived,
          admissionFeePaid: member.admissionFeePaid ?? 0,
          oneTimePaymentAmount: member.oneTimePaymentAmount ?? 0,
          oneTimePaymentPaid: member.oneTimePaymentPaid,
          monthlyPaymentAmount: member.monthlyPaymentAmount ?? 0,
        },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/members/:id/photo — upload / replace member portrait (compressed ~50KB JPEG)
router.post(
  '/:id/photo',
  requireGymPermission('gym.members.manage'),
  validate(getMemberSchema),
  parseMemberPhotoUpload,
  async (req: AuthRequest, res: Response) => {
    try {
      await ensureMemberPhotoUrlColumnOrThrow();

      const gymId = req.gymId!;
      const { id } = req.params;
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const file = (req as AuthRequest & { file?: Express.Multer.File }).file;

      if (!file?.buffer?.length) {
        sendError(res, new ValidationError('Missing file field "photo"'));
        return;
      }

      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        select: { id: true, photoUrl: true },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      const compressed = await compressMemberPhoto(file.buffer);
      const photoUrl = await storeMemberPhoto(compressed, gymId);

      const updated = await prisma.member.update({
        where: { id: member.id },
        data: { photoUrl },
        select: {
          id: true,
          legacyMemberId: true,
          name: true,
          photoUrl: true,
          updatedAt: true,
        },
      });

      // Replace: remove previous blob/file after successful DB update
      if (member.photoUrl && member.photoUrl !== photoUrl) {
        await deleteStoredMemberPhoto(member.photoUrl);
      }

      sendSuccess(
        res,
        {
          ...formatMemberResponse(updated as any),
          photo: {
            url: photoUrl,
            sizeBytes: compressed.sizeBytes,
            width: compressed.width,
            height: compressed.height,
            mimeType: compressed.mimeType,
          },
        },
        'Member photo uploaded',
        201
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/members/:id/photo — clear member portrait
router.delete(
  '/:id/photo',
  requireGymPermission('gym.members.manage'),
  validate(getMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      await ensureMemberPhotoUrlColumnOrThrow();

      const gymId = req.gymId!;
      const { id } = req.params;
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);

      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        select: { id: true, photoUrl: true, legacyMemberId: true, name: true },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      if (!member.photoUrl) {
        sendSuccess(
          res,
          {
            ...formatMemberResponse({ ...member, photoUrl: null } as any),
            photoUrl: null,
          },
          'Member has no photo'
        );
        return;
      }

      const previousUrl = member.photoUrl;
      const updated = await prisma.member.update({
        where: { id: member.id },
        data: { photoUrl: null },
        select: {
          id: true,
          legacyMemberId: true,
          name: true,
          photoUrl: true,
          updatedAt: true,
        },
      });

      await deleteStoredMemberPhoto(previousUrl);

      sendSuccess(
        res,
        {
          ...formatMemberResponse(updated as any),
          photoUrl: null,
        },
        'Member photo removed'
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/members
router.post(
  '/',
  requireGymPermission('gym.members.manage'),
  validate(createMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const {
        legacyMemberId: legacyMemberIdInput,
        name,
        phone,
        email,
        gender,
        dateOfBirth,
        cnic,
        comments,
        packageId,
        discount,
        admissionFeeWaived = false,
        trainerIds = [],
      } = req.body;

      const legacyMemberIdInputTrimmed = legacyMemberIdInput?.trim() || null;
      let assignedLegacyMemberId =
        legacyMemberIdInputTrimmed || (await allocateNextLegacyMemberId(gymId));

      await assertLegacyMemberIdAvailable(gymId, assignedLegacyMemberId);

      // Get gym settings (admission fee, discount cap)
      const gym = await prisma.gym.findUnique({
        where: { id: gymId },
        select: { admissionFee: true, maxMemberDiscount: true },
      });

      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      await assertGymCanAddActiveMember(gymId);

      const admissionFee = gym.admissionFee ?? 0;
      const maxMemberDiscount = resolveMaxMemberDiscount(gym);
      assertMemberDiscountWithinLimit(discount, maxMemberDiscount);

      // Validate package exists if provided
      let packageData = null;
      if (packageId) {
        packageData = await prisma.package.findFirst({
          where: { id: packageId, gymId },
        });
        if (!packageData) {
          sendError(res, new NotFoundError('Package', packageId));
          return;
        }
      }

      // Validate trainers exist and are active if provided
      let trainers: Trainer[] = [];
      if (trainerIds.length > 0) {
        trainers = await prisma.trainer.findMany({
          where: { id: { in: trainerIds }, gymId },
        });
        if (trainers.length !== trainerIds.length) {
          sendError(res, new NotFoundError('One or more trainers'));
          return;
        }
        const inactive = trainers.filter((t) => !t.isActive);
        if (inactive.length > 0) {
          sendError(
            res,
            new ValidationError(
              `Cannot assign inactive trainer(s): ${inactive.map((t) => t.name).join(', ')}`
            )
          );
          return;
        }
      }

      // Parse date of birth
      const dob = parseMemberDateOfBirth(dateOfBirth);
      const membershipStart = new Date();

      // Calculate payment amounts (one-time = admission + first month; monthly = package + trainer − discount)
      const admissionFeePaid = admissionFeeWaived ? 0 : admissionFee;
      const signupFees = computeSignupOneTimeFees({
        admissionFeePaid,
        packageData: packageData ?? null,
        trainers,
        memberDiscount: discount,
      });

      let member: any = null;
      const maxIdAttempts = legacyMemberIdInputTrimmed ? 1 : 5;
      for (let attempt = 0; attempt < maxIdAttempts; attempt++) {
        if (attempt > 0) {
          assignedLegacyMemberId = await allocateNextLegacyMemberId(gymId);
          await assertLegacyMemberIdAvailable(gymId, assignedLegacyMemberId);
        }

        try {
          member = await prisma.member.create({
            data: {
              gymId,
              legacyMemberId: assignedLegacyMemberId,
              name,
              phone: phone || null,
              email: normalizeEmailOrNull(email),
              gender: gender || null,
              dateOfBirth: dob,
              cnic: cnic || null,
              comments: comments || null,
              packageId: packageId || null,
              discount: discount || null,
              membershipStart,
              admissionFeeWaived,
              admissionFeePaid,
              oneTimePaymentAmount: signupFees.totalAmount,
              monthlyPaymentAmount: signupFees.monthlyInstallmentAmount,
              trainers: {
                create: trainerIds.map((trainerId: string) => ({
                  trainerId,
                })),
              },
            } as any,
            include: {
              package: true,
              trainers: {
                include: {
                  trainer: true,
                },
              },
            },
          });
          break;
        } catch (error) {
          if (!legacyMemberIdInputTrimmed && isLegacyMemberIdUniqueViolation(error)) {
            continue;
          }
          throw error;
        }
      }

      if (!member) {
        throw new ValidationError('Could not assign a unique member ID. Please try again.');
      }

      // Create one-time payment record (signup = admission + first month)
      if (signupFees.admissionFee > 0 || signupFees.firstMonthRecurring > 0) {
        await prisma.oneTimePayment.create({
          data: {
            gymId,
            memberId: member.id,
            admissionFee: signupFees.admissionFee,
            packageFee: signupFees.packageFee,
            trainerFee: signupFees.trainerFee,
            totalAmount: signupFees.totalAmount,
            status: 'PENDING',
          },
        });
      }

      // Monthly installments start after first month (covered by one-time when applicable)
      if (packageId) {
        await generatePaymentsForMember(member.id, gymId, packageId, membershipStart, {
          skipFirstInstallment: signupFees.firstMonthRecurring > 0,
        });
      }

      // Get one-time payment record
      const oneTimePayment = await prisma.oneTimePayment.findFirst({
        where: { memberId: member.id, gymId },
        orderBy: { createdAt: 'desc' },
      });

      sendSuccess(
        res,
        {
          ...formatMemberResponse(member),
          trainers: member.trainers.map((mt: any) => mt.trainer),
          oneTimePayment: oneTimePayment || null,
          paymentSummary: {
            admissionFeeWaived: member.admissionFeeWaived,
            admissionFeePaid: member.admissionFeePaid ?? 0,
            oneTimePaymentAmount: member.oneTimePaymentAmount ?? 0,
            oneTimePaymentPaid: member.oneTimePaymentPaid,
            monthlyPaymentAmount: member.monthlyPaymentAmount ?? 0,
          },
        },
        'Member created successfully',
        201
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

async function updateMemberHandler(req: AuthRequest, res: Response): Promise<void> {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      // id is transformed to number by validation middleware
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const {
        legacyMemberId,
        name,
        phone,
        email,
        gender,
        dateOfBirth,
        cnic,
        comments,
        packageId,
        discount,
        trainerIds,
      } = req.body;

      // Check if member exists
      const existingMember = await prisma.member.findFirst({
        where: { id: memberId, gymId },
      });

      if (!existingMember) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      if (discount !== undefined) {
        const gym = await prisma.gym.findUnique({
          where: { id: gymId },
          select: { maxMemberDiscount: true },
        });
        if (!gym) {
          sendError(res, new NotFoundError('Gym', gymId));
          return;
        }
        assertMemberDiscountWithinLimit(discount, resolveMaxMemberDiscount(gym));
      }

      // Validate package exists if provided
      if (packageId) {
        const packageExists = await prisma.package.findFirst({
          where: { id: packageId, gymId },
        });
        if (!packageExists) {
          sendError(res, new NotFoundError('Package', packageId));
          return;
        }
      }

      // Validate trainers exist and are active if provided
      if (trainerIds && trainerIds.length > 0) {
        const trainers = await prisma.trainer.findMany({
          where: { id: { in: trainerIds }, gymId },
        });
        if (trainers.length !== trainerIds.length) {
          sendError(res, new NotFoundError('One or more trainers'));
          return;
        }
        const inactive = trainers.filter((t) => !t.isActive);
        if (inactive.length > 0) {
          sendError(
            res,
            new ValidationError(
              `Cannot assign inactive trainer(s): ${inactive.map((t) => t.name).join(', ')}`
            )
          );
          return;
        }
      }

      // Parse date of birth
      const dob = dateOfBirth !== undefined ? parseMemberDateOfBirth(dateOfBirth) : undefined;
      const membershipStart = existingMember.membershipStart || new Date();

      // Update member
      const updateData: any = {};
      if (legacyMemberId !== undefined) {
        const trimmedLegacy =
          legacyMemberId === null || legacyMemberId === ''
            ? null
            : String(legacyMemberId).trim() || null;

        if (trimmedLegacy) {
          await assertLegacyMemberIdAvailable(gymId, trimmedLegacy, memberId);
          updateData.legacyMemberId = trimmedLegacy;
        } else if (!existingMember.legacyMemberId?.trim()) {
          const nextId = await allocateNextLegacyMemberId(gymId);
          await assertLegacyMemberIdAvailable(gymId, nextId, memberId);
          updateData.legacyMemberId = nextId;
        }
      }
      if (name !== undefined) updateData.name = name;
      if (phone !== undefined) updateData.phone = phone;
      if (email !== undefined) updateData.email = normalizeEmailOrNull(email);
      if (gender !== undefined) updateData.gender = gender;
      if (dateOfBirth !== undefined) updateData.dateOfBirth = dob;
      if (cnic !== undefined) updateData.cnic = cnic;
      if (comments !== undefined) updateData.comments = comments;
      if (discount !== undefined) updateData.discount = discount;

      // Handle package change
      if (packageId !== undefined) {
        updateData.packageId = packageId;
        const packageChanged = packageId !== existingMember.packageId;
        if (packageChanged && packageId) {
          updateData.membershipStart = membershipStart;
        }
      }

      const member = await prisma.member.update({
        where: { id: memberId },
        data: {
          ...updateData,
          ...(trainerIds !== undefined && {
            trainers: {
              deleteMany: {},
              create: trainerIds.map((trainerId: string) => ({
                trainerId,
              })),
            },
          }),
        },
        include: {
          package: true,
          trainers: {
            include: {
              trainer: true,
            },
          },
        },
      });

      // Regenerate payments if package changed and new package is assigned
      if (packageId !== undefined && packageId !== existingMember.packageId && packageId) {
        await generatePaymentsForMember(member.id, gymId, packageId, membershipStart);
      } else if (
        packageId !== undefined ||
        trainerIds !== undefined ||
        discount !== undefined
      ) {
        await refreshMemberOpenInstallmentAmounts(member.id, gymId);
      }

      // Get one-time payment record
      const oneTimePayment = await prisma.oneTimePayment.findFirst({
        where: { memberId: member.id, gymId },
        orderBy: { createdAt: 'desc' },
      });

      sendSuccess(
        res,
        {
          ...formatMemberResponse(member as any),
          trainers: member.trainers.map((mt) => mt.trainer),
          oneTimePayment: oneTimePayment || null,
          paymentSummary: {
            admissionFeeWaived: member.admissionFeeWaived,
            admissionFeePaid: member.admissionFeePaid ?? 0,
            oneTimePaymentAmount: member.oneTimePaymentAmount ?? 0,
            oneTimePaymentPaid: member.oneTimePaymentPaid,
            monthlyPaymentAmount: member.monthlyPaymentAmount ?? 0,
          },
        },
        'Member updated successfully'
      );
    } catch (error) {
      sendError(res, error as Error);
    }
}

// PUT /api/members/:id — full or partial update
router.put(
  '/:id',
  requireGymPermission('gym.members.manage'),
  validate(updateMemberSchema),
  updateMemberHandler
);

// PATCH /api/members/:id — same as PUT (partial update for edit forms)
router.patch(
  '/:id',
  requireGymPermission('gym.members.manage'),
  validate(updateMemberSchema),
  updateMemberHandler
);

// PATCH /api/members/:id/deactivate
router.patch(
  '/:id/deactivate',
  requireGymPermission('gym.members.manage'),
  validate(deactivateMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      await ensureMemberStatusColumnsOrThrow();
      const { id } = req.params;
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const effectiveDate = resolveMemberStatusEffectiveDate(req.body?.effectiveDate);

      const member: any = await prisma.member.findFirst({
        where: { id: memberId, gymId },
      });
      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }
      if (!member.isActive) {
        sendError(res, new ValidationError('Member is already inactive'));
        return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.member.update({
          where: { id: memberId },
          data: {
            isActive: false,
            inactiveFrom: effectiveDate,
            billingResumeFrom: null,
          } as any,
        });

        // Remove all unpaid installments from inactive date onward so overdue is cleared.
        await tx.payment.deleteMany({
          where: {
            gymId,
            memberId,
            status: { in: ['PENDING', 'OVERDUE'] },
            dueDate: { gte: effectiveDate },
          },
        });
      });

      const updated: any = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        include: {
          package: true,
          trainers: {
            include: {
              trainer: true,
            },
          },
        },
      });

      sendSuccess(
        res,
        {
          ...formatMemberResponse(updated as any),
          trainers: updated?.trainers.map((mt: any) => mt.trainer) ?? [],
        },
        'Member deactivated successfully'
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PATCH /api/members/:id/reactivate
router.patch(
  '/:id/reactivate',
  requireGymPermission('gym.members.manage'),
  validate(reactivateMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const effectiveDate = resolveMemberStatusEffectiveDate(req.body?.effectiveDate);

      const member: any = await prisma.member.findFirst({
        where: { id: memberId, gymId },
      });
      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }
      if (member.isActive) {
        sendError(res, new ValidationError('Member is already active'));
        return;
      }

      await assertGymCanAddActiveMember(gymId);

      const inactiveFrom = member.inactiveFrom;
      if (!inactiveFrom) {
        sendError(res, new ValidationError('Inactive start date is missing for this member'));
        return;
      }
      if (effectiveDate.getTime() < inactiveFrom.getTime()) {
        sendError(res, new ValidationError('effectiveDate cannot be before inactiveFrom'));
        return;
      }

      const dayMs = 24 * 60 * 60 * 1000;
      const pausedDays = Math.floor((effectiveDate.getTime() - inactiveFrom.getTime()) / dayMs);
      const newMembershipEnd = member.membershipEnd
        ? new Date(member.membershipEnd.getTime() + pausedDays * dayMs)
        : null;

      await prisma.member.update({
        where: { id: memberId },
        data: {
          isActive: true,
          inactiveFrom: null,
          billingResumeFrom: effectiveDate,
          ...(newMembershipEnd ? { membershipEnd: newMembershipEnd } : {}),
        } as any,
      });

      const monthKey = `${effectiveDate.getUTCFullYear()}-${String(
        effectiveDate.getUTCMonth() + 1
      ).padStart(2, '0')}`;
      await ensureMonthlyInstallmentsThroughMonthKey(memberId, gymId, monthKey);
      await syncMissingNextMonthlyInstallment(memberId, gymId);
      await markOverduePayments(gymId);

      const updated: any = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        include: {
          package: true,
          trainers: {
            include: {
              trainer: true,
            },
          },
        },
      });

      sendSuccess(
        res,
        {
          ...formatMemberResponse(updated as any),
          trainers: updated?.trainers.map((mt: any) => mt.trainer) ?? [],
        },
        'Member reactivated successfully'
      );
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/members/:id/payments - Get all payment history for a member
router.get(
  '/:id/payments',
  requireGymPermission('gym.payments.read'),
  validate(getMemberPaymentsSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const query = req.query as any;
      const {
        status,
        type = 'all',
        page = 1,
        limit = 50,
      } = query;

      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      // Verify member exists and belongs to gym
      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        select: { id: true, name: true, legacyMemberId: true },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      await markOverduePayments(gymId);

      const pendingOneTimeMap = await getPendingOneTimeByMemberIds(gymId, [memberId]);
      const pendingOneTime = pendingOneTimeMap.get(memberId) ?? null;

      if (type === 'all' || type === 'monthly') {
        await refreshMemberOpenInstallmentAmounts(memberId, gymId);
        await syncMissingNextMonthlyInstallment(memberId, gymId);
        await markOverduePayments(gymId);
      }

      const normalizedStatus = status ? String(status).toUpperCase() : null;
      const whereMonthly: any = { gymId, memberId };
      const whereOneTime: any = { gymId, memberId };

      if (normalizedStatus) {
        whereMonthly.status = normalizedStatus as 'PENDING' | 'PAID' | 'OVERDUE';
        whereOneTime.status = normalizedStatus as 'PENDING' | 'PAID' | 'OVERDUE';
      }

      let allMonthlyForTimeline: any[] = [];
      let monthlyPayments: any[] = [];
      let oneTimePayments: any[] = [];
      let monthlyTotal = 0;
      let oneTimeTotal = 0;

      if (type === 'all' || type === 'monthly') {
        const whereTimeline = { gymId, memberId };
        if (normalizedStatus) {
          (whereTimeline as any).status = normalizedStatus;
        }

        [monthlyTotal, allMonthlyForTimeline, monthlyPayments] = await Promise.all([
          prisma.payment.count({ where: whereMonthly }),
          prisma.payment.findMany({
            where: whereTimeline,
            orderBy: { dueDate: 'asc' },
          }),
          prisma.payment.findMany({
            where: whereMonthly,
            orderBy: { dueDate: 'desc' },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
          }),
        ]);
      }

      if (type === 'all' || type === 'one-time') {
        [oneTimeTotal, oneTimePayments] = await Promise.all([
          prisma.oneTimePayment.count({ where: whereOneTime }),
          prisma.oneTimePayment.findMany({
            where: whereOneTime,
            orderBy: { createdAt: 'desc' },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
          }),
        ]);
      }

      const formatMonthly = (payment: (typeof allMonthlyForTimeline)[0]) => ({
        id: payment.id,
        type: 'monthly' as const,
        month: payment.month,
        amount: payment.amount,
        status: payment.status,
        dueDate: payment.dueDate,
        paidDate: payment.paidDate,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      });

      const formattedMonthlyTimeline = allMonthlyForTimeline.map(formatMonthly);

      const gymTz = getGymTimezone();

      const monthlyInstallments = formattedMonthlyTimeline.map((p) => ({
        ...p,
        displayBucket: installmentDisplayBucket(p.status, p.dueDate, gymTz),
      }));

      const monthlyGrouped = {
        paid: monthlyInstallments.filter((p) => p.displayBucket === 'paid'),
        overdue: monthlyInstallments.filter((p) => p.displayBucket === 'overdue'),
        pending: monthlyInstallments.filter((p) => p.displayBucket === 'pending'),
        advance: monthlyInstallments.filter((p) => p.displayBucket === 'advance'),
      };

      const formattedMonthlyPayments = monthlyPayments.map(formatMonthly);

      const formattedOneTimePayments = oneTimePayments.map((payment) => {
        const normalized = normalizeOneTimePaymentBreakdown(payment);
        return {
          id: payment.id,
          type: 'one-time' as const,
          admissionFee: normalized.admissionFee,
          packageFee: normalized.packageFee,
          trainerFee: normalized.trainerFee,
          totalAmount: normalized.totalAmount,
          status: payment.status,
          paidDate: payment.paidDate,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt,
          receiptPath: `/api/payments/one-time/${payment.id}/receipt`,
        };
      });

      const allPayments = [...formattedMonthlyPayments, ...formattedOneTimePayments].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      const totalPayments = monthlyTotal + oneTimeTotal;

      sendSuccess(res, {
        member: withMemberNumber({
          id: member.id,
          legacyMemberId: (member as any).legacyMemberId ?? null,
          name: member.name,
        }),
        pendingOneTime,
        monthlyInstallments,
        monthlyGrouped,
        payments: allPayments,
        summary: {
          monthly: {
            total: monthlyInstallments.length,
            paid: monthlyInstallments.filter((p) => p.displayBucket === 'paid').length,
            pending: monthlyInstallments.filter((p) => p.displayBucket === 'pending').length,
            overdue: monthlyInstallments.filter((p) => p.displayBucket === 'overdue').length,
            advance: monthlyInstallments.filter((p) => p.displayBucket === 'advance').length,
          },
          oneTime: {
            total: oneTimeTotal,
            paid: oneTimePayments.filter((p) => p.status === 'PAID').length,
            pending: oneTimePayments.filter((p) => p.status === 'PENDING').length,
          },
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalPayments,
          totalPages: Math.ceil(totalPayments / limitNum),
        },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/members/:id/payments/mark-month-paid — mark monthly installment for YYYY-MM (portal projected month)
router.post(
  '/:id/payments/mark-month-paid',
  requireGymPermission('gym.payments.manage'),
  validate(markMemberMonthPaidSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const rawId = req.params.id;
      const memberId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10);
      const { month } = req.body as { month: string };

      const updated = await markMonthlyInstallmentByYearMonth(gymId, memberId, month);

      sendSuccess(res, updated, 'Payment marked as paid');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/members/:id
router.delete(
  '/:id',
  requireGymPermission('gym.members.delete'),
  validate(deleteMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      // id is transformed to number by validation middleware
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);

      const photoUrlAvailable = await hasMemberPhotoUrlColumn();
      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        select: photoUrlAvailable
          ? { id: true, photoUrl: true }
          : { id: true },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      const previousPhotoUrl =
        photoUrlAvailable && 'photoUrl' in member
          ? (member.photoUrl as string | null)
          : null;

      // Delete member (cascades to payments and attendance records)
      await prisma.member.delete({
        where: { id: memberId },
      });

      // Remove portrait from blob/disk so deleted members leave no storage garbage
      await deleteStoredMemberPhoto(previousPhotoUrl);

      sendSuccess(res, { message: 'Member deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

