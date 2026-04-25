import { Router, Response } from 'express';
import type { Trainer } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
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
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  parseDate,
  installmentDisplayBucket,
  getGymTimezone,
  startOfGymCalendarDayUtc,
  startOfNextGymCalendarDayUtc,
} from '../utils/dateHelpers';
import {
  generatePaymentsForMember,
  markOverduePayments,
  markMonthlyInstallmentByYearMonth,
  syncMissingNextMonthlyInstallment,
  ensureMonthlyInstallmentsThroughMonthKey,
} from '../services/paymentService';

const router = Router();

let memberStatusColumnsAvailableCache: boolean | null = null;

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

function parseMemberDateOfBirth(input: unknown): Date | null {
  if (input === undefined || input === null || input === '') return null;
  const value = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return parseDate(value);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('dateOfBirth must be YYYY-MM-DD or ISO 8601 datetime string', [
      {
        path: 'body.dateOfBirth',
        message: 'Expected YYYY-MM-DD or ISO 8601 datetime',
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

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/members
router.get(
  '/',
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
          // If search is a number, also search by ID
          ...(isNaN(searchNum) ? [] : [{ id: searchNum }]),
        ];
      }

      // Validate sortBy to prevent SQL injection and ensure it uses indexed fields
      const validSortFields = ['id', 'name', 'createdAt', 'updatedAt', 'membershipStart'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

      // Get total count and members in parallel for better performance
      const statusColsAvailable = await hasMemberStatusColumns();

      const [total, members] = await Promise.all([
        prisma.member.count({ where }),
        prisma.member.findMany({
          where,
          select: {
            id: true,
            gymId: true,
            name: true,
            phone: true,
            email: true,
            gender: true,
            dateOfBirth: true,
            cnic: true,
            comments: true,
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

      // Format response with payment summary
      const formattedMembers = members.map((member: any) => ({
        ...normalizeMemberDobForResponse(member),
        isActive: member.isActive ?? true,
        inactiveFrom: member.inactiveFrom ?? null,
        billingResumeFrom: member.billingResumeFrom ?? null,
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

// GET /api/members/:id
router.get(
  '/:id',
  validate(getMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      // id is transformed to number by validation middleware
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);

      const statusColsAvailable = await hasMemberStatusColumns();

      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        select: {
          id: true,
          gymId: true,
          name: true,
          phone: true,
          email: true,
          gender: true,
          dateOfBirth: true,
          cnic: true,
          comments: true,
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
        ...normalizeMemberDobForResponse(member as any),
        isActive: (member as any).isActive ?? true,
        inactiveFrom: (member as any).inactiveFrom ?? null,
        billingResumeFrom: (member as any).billingResumeFrom ?? null,
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

// POST /api/members
router.post(
  '/',
  validate(createMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const {
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

      // Get gym settings (admission fee)
      const gym = await prisma.gym.findUnique({
        where: { id: gymId },
        select: { admissionFee: true },
      });

      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const admissionFee = gym.admissionFee ?? 0;

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

      // Validate trainers exist if provided
      let trainers: Trainer[] = [];
      if (trainerIds.length > 0) {
        trainers = await prisma.trainer.findMany({
          where: { id: { in: trainerIds }, gymId },
        });
        if (trainers.length !== trainerIds.length) {
          sendError(res, new NotFoundError('One or more trainers'));
          return;
        }
      }

      // Parse date of birth
      const dob = parseMemberDateOfBirth(dateOfBirth);
      const membershipStart = new Date();

      // Calculate payment amounts
      const admissionFeePaid = admissionFeeWaived ? 0 : admissionFee;
      
      // Package fee (after discount)
      const packageDiscount = discount ?? packageData?.discount ?? 0;
      const packageFee = packageData ? Math.max(0, packageData.price - packageDiscount) : 0;
      
      // Trainer fees (sum of all trainer charges)
      const trainerFee = trainers.reduce((sum, trainer) => sum + (trainer.charges ?? 0), 0);
      
      // Total one-time payment
      const oneTimePaymentAmount = admissionFeePaid + packageFee + trainerFee;
      
      // Monthly payment amount (package fee only, for recurring payments)
      const monthlyPaymentAmount = packageFee;

      // Create member (ID will be auto-generated)
      const member: any = await prisma.member.create({
        data: {
          gymId,
          name,
          phone: phone || null,
          email: email || null,
          gender: gender || null,
          dateOfBirth: dob,
          cnic: cnic || null,
          comments: comments || null,
          packageId: packageId || null,
          discount: discount || null,
          membershipStart,
          billingResumeFrom: membershipStart,
          admissionFeeWaived,
          admissionFeePaid,
          oneTimePaymentAmount,
          monthlyPaymentAmount,
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

      // Create one-time payment record
      if (oneTimePaymentAmount > 0) {
        await prisma.oneTimePayment.create({
          data: {
            gymId,
            memberId: member.id,
            admissionFee: admissionFeePaid,
            packageFee,
            trainerFee,
            totalAmount: oneTimePaymentAmount,
            status: 'PENDING',
          },
        });
      }

      // Generate monthly payments if package is assigned
      if (packageId) {
        await generatePaymentsForMember(member.id, gymId, packageId, membershipStart);
      }

      // Get one-time payment record
      const oneTimePayment = await prisma.oneTimePayment.findFirst({
        where: { memberId: member.id, gymId },
        orderBy: { createdAt: 'desc' },
      });

      sendSuccess(
        res,
        {
          ...normalizeMemberDobForResponse(member),
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

// PUT /api/members/:id
router.put(
  '/:id',
  validate(updateMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      await ensureMemberStatusColumnsOrThrow();
      const { id } = req.params;
      // id is transformed to number by validation middleware
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const {
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

      // Validate trainers exist if provided
      if (trainerIds && trainerIds.length > 0) {
        const trainers = await prisma.trainer.findMany({
          where: { id: { in: trainerIds }, gymId },
        });
        if (trainers.length !== trainerIds.length) {
          sendError(res, new NotFoundError('One or more trainers'));
          return;
        }
      }

      // Parse date of birth
      const dob = dateOfBirth !== undefined ? parseMemberDateOfBirth(dateOfBirth) : undefined;
      const membershipStart = existingMember.membershipStart || new Date();

      // Update member
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (phone !== undefined) updateData.phone = phone;
      if (email !== undefined) updateData.email = email;
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
      }

      // Get one-time payment record
      const oneTimePayment = await prisma.oneTimePayment.findFirst({
        where: { memberId: member.id, gymId },
        orderBy: { createdAt: 'desc' },
      });

      sendSuccess(
        res,
        {
          ...normalizeMemberDobForResponse(member as any),
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
);

// PATCH /api/members/:id/deactivate
router.patch(
  '/:id/deactivate',
  validate(deactivateMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      await ensureMemberStatusColumnsOrThrow();
      const { id } = req.params;
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const effectiveDate = req.body?.effectiveDate
        ? parseDate(req.body.effectiveDate)
        : parseDate(new Date().toISOString().slice(0, 10));

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
          ...updated,
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
  validate(reactivateMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);
      const effectiveDate = req.body?.effectiveDate
        ? parseDate(req.body.effectiveDate)
        : parseDate(new Date().toISOString().slice(0, 10));

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
          ...updated,
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
        select: { id: true, name: true },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      await markOverduePayments(gymId);

      if (type === 'all' || type === 'monthly') {
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

      const formattedOneTimePayments = oneTimePayments.map((payment) => ({
        id: payment.id,
        type: 'one-time' as const,
        admissionFee: payment.admissionFee,
        packageFee: payment.packageFee,
        trainerFee: payment.trainerFee,
        totalAmount: payment.totalAmount,
        status: payment.status,
        paidDate: payment.paidDate,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      }));

      const allPayments = [...formattedMonthlyPayments, ...formattedOneTimePayments].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      const totalPayments = monthlyTotal + oneTimeTotal;

      sendSuccess(res, {
        member: {
          id: member.id,
          name: member.name,
        },
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
  validate(deleteMemberSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      // id is transformed to number by validation middleware
      const memberId = typeof id === 'number' ? id : parseInt(id as string, 10);

      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', String(memberId)));
        return;
      }

      // Delete member (cascades to payments and attendance records)
      await prisma.member.delete({
        where: { id: memberId },
      });

      sendSuccess(res, { message: 'Member deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

