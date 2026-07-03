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
import {
  DEFAULT_AUTO_CHECKOUT_HOURS,
  getGymAttendancePolicy,
} from '../services/attendancePolicyService';

const router = Router();

router.use(authenticateToken);
router.use(requireGymId);

function formatSettingsResponse(gym: {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  admissionFee: number | null;
  autoCheckoutHours: number;
  absenceInactiveDays: number | null;
}) {
  const autoCheckoutHours = gym.autoCheckoutHours ?? DEFAULT_AUTO_CHECKOUT_HOURS;
  const absenceInactiveDays = gym.absenceInactiveDays ?? null;

  return {
    admissionFee: gym.admissionFee ?? 0,
    autoCheckoutHours,
    absenceInactiveDays,
    attendancePolicy: {
      autoCheckoutHours,
      absenceInactiveDays,
      absenceInactiveEnabled: absenceInactiveDays != null && absenceInactiveDays > 0,
    },
    gym: {
      id: gym.id,
      name: gym.name,
      address: gym.address,
      phone: gym.phone,
      email: gym.email,
    },
  };
}

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
          autoCheckoutHours: true,
          absenceInactiveDays: true,
        },
      });

      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      sendSuccess(res, formatSettingsResponse(gym));
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
      const { admissionFee, autoCheckoutHours, absenceInactiveDays } = req.body;

      const gym = await prisma.gym.findUnique({
        where: { id: gymId },
      });

      if (!gym) {
        sendError(res, new NotFoundError('Gym', gymId));
        return;
      }

      const updateData: {
        admissionFee?: number;
        autoCheckoutHours?: number;
        absenceInactiveDays?: number | null;
      } = {};

      if (admissionFee !== undefined) {
        updateData.admissionFee = admissionFee;
      }
      if (autoCheckoutHours !== undefined) {
        updateData.autoCheckoutHours = autoCheckoutHours;
      }
      if (absenceInactiveDays !== undefined) {
        updateData.absenceInactiveDays = absenceInactiveDays;
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
          autoCheckoutHours: true,
          absenceInactiveDays: true,
        },
      });

      sendSuccess(res, formatSettingsResponse(updatedGym), 'Settings updated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/settings/attendance-policy - Attendance automation settings
router.get('/attendance-policy', async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;
    const policy = await getGymAttendancePolicy(gymId);
    sendSuccess(res, policy);
  } catch (error) {
    sendError(res, error as Error);
  }
});

export default router;
