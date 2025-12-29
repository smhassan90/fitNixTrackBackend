import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  createTrainerSchema,
  updateTrainerSchema,
  getTrainersSchema,
  getTrainerSchema,
  deleteTrainerSchema,
} from '../validations/trainers';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';
import { parseDate } from '../utils/dateHelpers';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/trainers
router.get(
  '/',
  validate(getTrainersSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { search, sortBy = 'createdAt', sortOrder = 'desc', page, limit } = req.query as any;

      // Ensure page and limit are numbers
      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      const where: any = { gymId };

      // Search filter
      if (search) {
        where.OR = [
          { name: { contains: search } },
          { specialization: { contains: search } },
          { id: { contains: search } },
        ];
      }

      // Get total count
      const total = await prisma.trainer.count({ where });

      // Get trainers
      const trainers = await prisma.trainer.findMany({
        where,
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      });

      sendSuccess(res, {
        trainers,
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

// GET /api/trainers/:id
router.get(
  '/:id',
  validate(getTrainerSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const trainer = await prisma.trainer.findFirst({
        where: { id, gymId },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
          members: {
            include: {
              member: true,
            },
          },
        },
      });

      if (!trainer) {
        sendError(res, new NotFoundError('Trainer', id));
        return;
      }

      sendSuccess(res, {
        ...trainer,
        members: trainer.members.map((mt) => mt.member),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/trainers
router.post(
  '/',
  validate(createTrainerSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const {
        name,
        gender,
        dateOfBirth,
        specialization,
        charges,
        startTime,
        endTime,
      } = req.body;

      // Parse date of birth
      const dob = dateOfBirth ? parseDate(dateOfBirth) : null;

      // Create trainer
      const trainer = await prisma.trainer.create({
        data: {
          gymId,
          name,
          gender: gender || null,
          dateOfBirth: dob,
          specialization: specialization || null,
          charges: charges || null,
          startTime: startTime || null,
          endTime: endTime || null,
        },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      });

      sendSuccess(res, trainer, 'Trainer created successfully', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PUT /api/trainers/:id
router.put(
  '/:id',
  validate(updateTrainerSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const {
        name,
        gender,
        dateOfBirth,
        specialization,
        charges,
        startTime,
        endTime,
      } = req.body;

      // Check if trainer exists
      const existingTrainer = await prisma.trainer.findFirst({
        where: { id, gymId },
      });

      if (!existingTrainer) {
        sendError(res, new NotFoundError('Trainer', id));
        return;
      }

      // Parse date of birth
      const dob = dateOfBirth ? parseDate(dateOfBirth) : null;

      // Update trainer
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (gender !== undefined) updateData.gender = gender;
      if (dateOfBirth !== undefined) updateData.dateOfBirth = dob;
      if (specialization !== undefined) updateData.specialization = specialization;
      if (charges !== undefined) updateData.charges = charges;
      if (startTime !== undefined) updateData.startTime = startTime;
      if (endTime !== undefined) updateData.endTime = endTime;

      const trainer = await prisma.trainer.update({
        where: { id },
        data: updateData,
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      });

      sendSuccess(res, trainer, 'Trainer updated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/trainers/:id
router.delete(
  '/:id',
  validate(deleteTrainerSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const trainer = await prisma.trainer.findFirst({
        where: { id, gymId },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      });

      if (!trainer) {
        sendError(res, new NotFoundError('Trainer', id));
        return;
      }

      // Check if trainer has members
      if (trainer._count.members > 0) {
        sendError(
          res,
          new ValidationError('Cannot delete trainer with assigned members')
        );
        return;
      }

      // Delete trainer
      await prisma.trainer.delete({
        where: { id },
      });

      sendSuccess(res, { message: 'Trainer deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

