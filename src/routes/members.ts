import { Router, Response } from 'express';
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
} from '../validations/members';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError } from '../utils/errors';
import { parseDate } from '../utils/dateHelpers';
import { generatePaymentsForMember } from '../services/paymentService';

const router = Router();

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
      const { search, sortBy = 'createdAt', sortOrder = 'desc', page, limit } = req.query as any;

      // Ensure page and limit are numbers (validation middleware should handle this, but add safeguard)
      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      const where: any = { gymId };

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
      const [total, members] = await Promise.all([
        prisma.member.count({ where }),
        prisma.member.findMany({
          where,
          include: {
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
      const formattedMembers = members.map((member) => ({
        ...member,
        trainers: member.trainers.map((mt) => mt.trainer),
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

      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
        include: {
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
        ...member,
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
      let trainers = [];
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
      const dob = dateOfBirth ? parseDate(dateOfBirth) : null;
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
      const member = await prisma.member.create({
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
          admissionFeeWaived,
          admissionFeePaid,
          oneTimePaymentAmount,
          monthlyPaymentAmount,
          trainers: {
            create: trainerIds.map((trainerId: string) => ({
              trainerId,
            })),
          },
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
          ...member,
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
      const dob = dateOfBirth ? parseDate(dateOfBirth) : null;
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
          ...member,
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

      const normalizedStatus = status ? String(status).toUpperCase() : null;
      const whereMonthly: any = { gymId, memberId };
      const whereOneTime: any = { gymId, memberId };

      if (normalizedStatus) {
        whereMonthly.status = normalizedStatus as 'PENDING' | 'PAID' | 'OVERDUE';
        whereOneTime.status = normalizedStatus as 'PENDING' | 'PAID' | 'OVERDUE';
      }

      // Fetch payments based on type
      let monthlyPayments: any[] = [];
      let oneTimePayments: any[] = [];
      let monthlyTotal = 0;
      let oneTimeTotal = 0;

      if (type === 'all' || type === 'monthly') {
        [monthlyTotal, monthlyPayments] = await Promise.all([
          prisma.payment.count({ where: whereMonthly }),
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

      // Format monthly payments
      const formattedMonthlyPayments = monthlyPayments.map((payment) => ({
        id: payment.id,
        type: 'monthly',
        month: payment.month,
        amount: payment.amount,
        status: payment.status,
        dueDate: payment.dueDate,
        paidDate: payment.paidDate,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      }));

      // Format one-time payments
      const formattedOneTimePayments = oneTimePayments.map((payment) => ({
        id: payment.id,
        type: 'one-time',
        admissionFee: payment.admissionFee,
        packageFee: payment.packageFee,
        trainerFee: payment.trainerFee,
        totalAmount: payment.totalAmount,
        status: payment.status,
        paidDate: payment.paidDate,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      }));

      // Combine and sort by date (most recent first)
      const allPayments = [...formattedMonthlyPayments, ...formattedOneTimePayments].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      const totalPayments = monthlyTotal + oneTimeTotal;

      sendSuccess(res, {
        member: {
          id: member.id,
          name: member.name,
        },
        payments: allPayments,
        summary: {
          monthly: {
            total: monthlyTotal,
            paid: monthlyPayments.filter((p) => p.status === 'PAID').length,
            pending: monthlyPayments.filter((p) => p.status === 'PENDING').length,
            overdue: monthlyPayments.filter((p) => p.status === 'OVERDUE').length,
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

