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
  deactivateTrainerSchema,
  activateTrainerSchema,
} from '../validations/trainers';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';
import { parseDate, startOfGymCalendarDayUtc, startOfNextGymCalendarDayUtc } from '../utils/dateHelpers';

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
      const {
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        page,
        limit,
        createdFrom,
        createdTo,
        isActive,
      } = req.query as any;

      // Ensure page and limit are numbers
      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      const where: any = { gymId };

      if (isActive !== undefined) {
        where.isActive = isActive;
      }

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
          { phone: { contains: search } },
          { specialization: { contains: search } },
          ...(Number.isNaN(searchNum) ? [] : [{ id: searchNum }]),
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
      const id = parseInt(req.params.id, 10);

      const trainer = await (prisma.trainer.findFirst({
        where: { id: id as any, gymId: gymId as any },
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
      }) as any);

      if (!trainer) {
        sendError(res, new NotFoundError('Trainer', id));
        return;
      }

      sendSuccess(res, {
        ...trainer,
        members: (trainer.members || []).map((mt: any) => mt.member),
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
        phone,
        gender,
        dateOfBirth,
        specialization,
        charges,
        startTime,
        endTime,
        isActive,
      } = req.body;

      // Parse date of birth
      const dob = dateOfBirth ? parseDate(dateOfBirth) : null;

      // Create trainer
      const trainer = await prisma.trainer.create({
        data: {
          gymId,
          name,
          phone: phone && String(phone).trim() ? String(phone).trim() : null,
          gender: gender || null,
          dateOfBirth: dob,
          specialization: specialization || null,
          charges: charges || null,
          startTime: startTime || null,
          endTime: endTime || null,
          isActive: isActive ?? true,
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
async function updateTrainerHandler(req: AuthRequest, res: Response) {
  try {
    const gymId = req.gymId!;
    const { id } = req.params;
    const {
      name,
      phone,
      gender,
      dateOfBirth,
      specialization,
      charges,
      startTime,
      endTime,
      isActive,
    } = req.body;

    const existingTrainer = await prisma.trainer.findFirst({
      where: { id: id as any, gymId: gymId as any },
    });

    if (!existingTrainer) {
      sendError(res, new NotFoundError('Trainer', id));
      return;
    }

    const dob = dateOfBirth ? parseDate(dateOfBirth) : null;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) {
      updateData.phone = phone && String(phone).trim() ? String(phone).trim() : null;
    }
    if (gender !== undefined) updateData.gender = gender;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dob;
    if (specialization !== undefined) updateData.specialization = specialization;
    if (charges !== undefined) updateData.charges = charges;
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (isActive !== undefined) updateData.isActive = isActive;

    const trainer = await prisma.trainer.update({
      where: { id: id as any },
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

router.put('/:id', validate(updateTrainerSchema), updateTrainerHandler);

// PATCH /api/trainers/:id — partial update (same as PUT)
router.patch('/:id', validate(updateTrainerSchema), updateTrainerHandler);

// PATCH /api/trainers/:id/deactivate — must be registered before generic /:id if paths overlap
router.patch(
  '/:id/deactivate',
  validate(deactivateTrainerSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      const trainer = await prisma.trainer.findFirst({
        where: { id, gymId },
      });

      if (!trainer) {
        sendError(res, new NotFoundError('Trainer', id));
        return;
      }

      if (!trainer.isActive) {
        sendError(res, new ValidationError('Trainer is already inactive'));
        return;
      }

      const updated = await prisma.trainer.update({
        where: { id },
        data: { isActive: false },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      });

      sendSuccess(res, updated, 'Trainer deactivated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PATCH /api/trainers/:id/activate
router.patch(
  '/:id/activate',
  validate(activateTrainerSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      const trainer = await prisma.trainer.findFirst({
        where: { id, gymId },
      });

      if (!trainer) {
        sendError(res, new NotFoundError('Trainer', id));
        return;
      }

      if (trainer.isActive) {
        sendError(res, new ValidationError('Trainer is already active'));
        return;
      }

      const updated = await prisma.trainer.update({
        where: { id },
        data: { isActive: true },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      });

      sendSuccess(res, updated, 'Trainer activated successfully');
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
      const id = parseInt(req.params.id, 10);

      const trainer = await (prisma.trainer.findFirst({
        where: { id: id as any, gymId: gymId as any },
        include: {
          _count: {
            select: {
              members: true,
            },
          },
        },
      }) as any);

      if (!trainer) {
        sendError(res, new NotFoundError('Trainer', id));
        return;
      }

      // Check if trainer has members
      if (trainer._count?.members > 0) {
        sendError(
          res,
          new ValidationError('Cannot delete trainer with assigned members')
        );
        return;
      }

      // Delete trainer
      await prisma.trainer.delete({
        where: { id: id as any },
      });

      sendSuccess(res, { message: 'Trainer deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

