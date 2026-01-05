import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { requireRole } from '../middleware/auth';
import {
  getSettingsSchema,
  updateSettingsSchema,
} from '../validations/settings';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError } from '../utils/errors';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/settings - Get gym settings
router.get(
  '/',
  validate(getSettingsSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;

      const gym = await prisma.gym.findUnique({
        where: { id: gymId },
        select: {
          id: true,
          name: true,
          address: true,
          phone: true,
          email: true,
          admissionFee: true,
        },
      });

      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      sendSuccess(res, {
        admissionFee: gym.admissionFee ?? 0,
        gym: {
          id: gym.id,
          name: gym.name,
          address: gym.address,
          phone: gym.phone,
          email: gym.email,
        },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PUT /api/settings - Update gym settings (requires GYM_ADMIN role)
router.put(
  '/',
  validate(updateSettingsSchema),
  requireRole('GYM_ADMIN'),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { admissionFee } = req.body;

      const gym = await prisma.gym.findUnique({
        where: { id: gymId },
      });

      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const updateData: any = {};
      if (admissionFee !== undefined) {
        updateData.admissionFee = admissionFee;
      }

      const updatedGym = await prisma.gym.update({
        where: { id: gymId },
        data: updateData,
        select: {
          id: true,
          name: true,
          address: true,
          phone: true,
          email: true,
          admissionFee: true,
        },
      });

      sendSuccess(res, {
        admissionFee: updatedGym.admissionFee ?? 0,
        gym: {
          id: updatedGym.id,
          name: updatedGym.name,
          address: updatedGym.address,
          phone: updatedGym.phone,
          email: updatedGym.email,
        },
      }, 'Settings updated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

