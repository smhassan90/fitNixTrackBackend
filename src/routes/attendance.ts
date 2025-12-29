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
        page,
        limit,
      } = req.query as any;

      // Ensure page and limit are numbers
      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      const where: any = { gymId };

      // memberId is already transformed to number by validation middleware
      if (memberId) {
        const memberIdNum = typeof memberId === 'number' ? memberId : parseInt(memberId as string, 10);
        if (!isNaN(memberIdNum)) {
          where.memberId = memberIdNum;
        }
      }

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
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      });

      // Format records for frontend with calculated duration
      const formattedRecords = records.map((record: any) => {
        const checkInTime = record.checkInTime as Date | null;
        const checkOutTime = record.checkOutTime as Date | null;

        // Calculate duration in minutes
        let duration: number | null = null;
        let durationFormatted: string | null = null;

        if (checkInTime && checkOutTime) {
          const diffMs = checkOutTime.getTime() - checkInTime.getTime();
          duration = Math.round(diffMs / (1000 * 60)); // Duration in minutes

          // Format duration as "Xh Ym" or "Ym" or "Xm"
          const hours = Math.floor(duration / 60);
          const minutes = duration % 60;
          if (hours > 0) {
            durationFormatted = `${hours}h ${minutes}m`;
          } else {
            durationFormatted = `${minutes}m`;
          }
        } else if (checkInTime) {
          // Only check-in, no checkout yet
          durationFormatted = 'In Progress';
        }

        // Format contact (prefer phone, fallback to email)
        const contact = record.member.phone || record.member.email || 'N/A';

        // Format dates
        const dateFormatted = record.date.toISOString().split('T')[0]; // YYYY-MM-DD
        const checkInFormatted = checkInTime
          ? new Date(checkInTime).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : null;
        const checkOutFormatted = checkOutTime
          ? new Date(checkOutTime).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : null;

        return {
          id: record.id,
          date: dateFormatted,
          memberId: record.member.id,
          member: record.member.name,
          contact: contact,
          checkIn: checkInFormatted,
          checkOut: checkOutFormatted,
          checkInTime: checkInTime,
          checkOutTime: checkOutTime,
          status: record.status,
          duration: duration,
          durationFormatted: durationFormatted,
          // Include raw data for reference
          memberDetails: {
            email: record.member.email,
            phone: record.member.phone,
          },
        };
      });

      sendSuccess(res, {
        records: formattedRecords,
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

// GET /api/attendance/members - Get list of members for filter dropdown
router.get(
  '/members',
  authenticateToken,
  requireGymId,
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;

      const members = await prisma.member.findMany({
        where: { gymId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
        },
        orderBy: { name: 'asc' },
      });

      // Format for dropdown
      const memberOptions = members.map((member) => ({
        id: member.id,
        name: member.name,
        label: `${member.name} (ID: ${member.id})`,
        contact: member.phone || member.email || 'N/A',
      }));

      sendSuccess(res, { members: memberOptions });
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

      // Parse id as integer since it's now an auto-increment field
      const recordId = parseInt(id, 10);
      if (isNaN(recordId)) {
        sendError(res, new NotFoundError('Attendance record', id));
        return;
      }

      const record = await prisma.attendanceRecord.findFirst({
        where: { id: recordId, gymId },
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
      });

      if (!record) {
        sendError(res, new NotFoundError('Attendance record', id));
        return;
      }

      // Format single record
      const recordAny = record as any;
      const checkInTime = recordAny.checkInTime as Date | null;
      const checkOutTime = recordAny.checkOutTime as Date | null;

      const contact = record.member.phone || record.member.email || 'N/A';
      let duration: number | null = null;
      let durationFormatted: string | null = null;

      if (checkInTime && checkOutTime) {
        const diffMs = checkOutTime.getTime() - checkInTime.getTime();
        duration = Math.round(diffMs / (1000 * 60));
        const hours = Math.floor(duration / 60);
        const minutes = duration % 60;
        durationFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      } else if (checkInTime) {
        durationFormatted = 'In Progress';
      }

      const formattedRecord = {
        id: record.id,
        date: record.date.toISOString().split('T')[0],
        memberId: record.member.id,
        member: record.member.name,
        contact: contact,
        checkIn: checkInTime
          ? new Date(checkInTime).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : null,
        checkOut: checkOutTime
          ? new Date(checkOutTime).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : null,
        status: record.status,
        duration: duration,
        durationFormatted: durationFormatted,
        checkInTime: checkInTime,
        checkOutTime: checkOutTime,
      };

      sendSuccess(res, formattedRecord);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

