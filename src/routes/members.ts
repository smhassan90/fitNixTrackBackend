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
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
          // If search is a number, also search by ID
          ...(isNaN(searchNum) ? [] : [{ id: searchNum }]),
        ];
      }

      // Get total count
      const total = await prisma.member.count({ where });

      // Get members
      const members = await prisma.member.findMany({
        where,
        include: {
          package: true,
          trainers: {
            include: {
              trainer: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      });

      // Format response
      const formattedMembers = members.map((member) => ({
        ...member,
        trainers: member.trainers.map((mt) => mt.trainer),
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

      const member = await prisma.member.findFirst({
        where: { id, gymId },
        include: {
          package: true,
          trainers: {
            include: {
              trainer: true,
            },
          },
        },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', id));
        return;
      }

      sendSuccess(res, {
        ...member,
        trainers: member.trainers.map((mt) => mt.trainer),
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
        trainerIds = [],
      } = req.body;

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
      if (trainerIds.length > 0) {
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
      const membershipStart = new Date();

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

      // Generate payments if package is assigned
      if (packageId) {
        await generatePaymentsForMember(member.id, gymId, packageId, membershipStart);
      }

      sendSuccess(
        res,
        {
          ...member,
          trainers: member.trainers.map((mt) => mt.trainer),
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
        where: { id, gymId },
      });

      if (!existingMember) {
        sendError(res, new NotFoundError('Member', id));
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
      const packageChanged = packageId !== undefined && packageId !== existingMember.packageId;
      if (packageChanged) {
        updateData.packageId = packageId;
        updateData.membershipStart = membershipStart;
      }

      const member = await prisma.member.update({
        where: { id },
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

      // Regenerate payments if package changed
      if (packageChanged && packageId) {
        await generatePaymentsForMember(member.id, gymId, packageId, membershipStart);
      }

      sendSuccess(
        res,
        {
          ...member,
          trainers: member.trainers.map((mt) => mt.trainer),
        },
        'Member updated successfully'
      );
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

      const member = await prisma.member.findFirst({
        where: { id, gymId },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', id));
        return;
      }

      // Delete member (cascades to payments and attendance records)
      await prisma.member.delete({
        where: { id },
      });

      sendSuccess(res, { message: 'Member deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

