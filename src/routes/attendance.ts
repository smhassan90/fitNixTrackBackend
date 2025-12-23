import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  getAttendanceSchema,
  getAttendanceRecordSchema,
} from '../validations/attendance';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError } from '../utils/errors';
import { parseDate, getStartOfDay, getEndOfDay } from '../utils/dateHelpers';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/attendance
router.get(
  '/',
  validate(getAttendanceSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const {
        memberId,
        startDate,
        endDate,
        sortBy = 'date',
        sortOrder = 'desc',
        page = 1,
        limit = 50,
      } = req.query as any;

      const where: any = { gymId };

      if (memberId) where.memberId = memberId;

      // Date range filter
      if (startDate || endDate) {
        where.date = {};
        if (startDate) {
          where.date.gte = getStartOfDay(parseDate(startDate));
        }
        if (endDate) {
          where.date.lte = getEndOfDay(parseDate(endDate));
        }
      }

      // Get total count
      const total = await prisma.attendanceRecord.count({ where });

      // Get attendance records
      const records = await prisma.attendanceRecord.findMany({
        where,
        include: {
          member: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      });

      sendSuccess(res, {
        records,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/attendance/:id
router.get(
  '/:id',
  validate(getAttendanceRecordSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const record = await prisma.attendanceRecord.findFirst({
        where: { id, gymId },
        include: {
          member: true,
        },
      });

      if (!record) {
        sendError(res, new NotFoundError('Attendance record', id));
        return;
      }

      sendSuccess(res, record);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

