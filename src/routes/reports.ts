import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { getAttendanceReportSchema } from '../validations/reports';
import { sendSuccess, sendError } from '../utils/response';
import { parseDate, getStartOfDay, getEndOfDay } from '../utils/dateHelpers';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/reports/attendance
router.get(
  '/attendance',
  validate(getAttendanceReportSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { startDate, endDate } = req.query as any;

      const where: any = { gymId };

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

      // Get all attendance records
      const records = await prisma.attendanceRecord.findMany({
        where,
        include: {
          member: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: {
          date: 'desc',
        },
      });

      // Calculate statistics
      const total = records.length;
      const present = records.filter((r) => r.status === 'PRESENT').length;
      const absent = records.filter((r) => r.status === 'ABSENT').length;
      const late = records.filter((r) => r.status === 'LATE').length;

      // Calculate consecutive absences
      const memberAbsences: Record<string, { name: string; consecutive: number; lastAbsent: Date }> = {};

      // Sort records by date for each member
      const memberRecords: Record<string, typeof records> = {};
      records.forEach((record) => {
        if (!memberRecords[record.memberId]) {
          memberRecords[record.memberId] = [];
        }
        memberRecords[record.memberId].push(record);
      });

      // Calculate consecutive absences for each member
      Object.entries(memberRecords).forEach(([memberId, memberRecs]) => {
        // Sort by date descending
        const sorted = [...memberRecs].sort((a, b) => b.date.getTime() - a.date.getTime());

        let consecutive = 0;
        let lastAbsent: Date | null = null;

        for (const record of sorted) {
          if (record.status === 'ABSENT') {
            if (consecutive === 0) {
              lastAbsent = record.date;
            }
            consecutive++;
          } else {
            break;
          }
        }

        if (consecutive >= 3) {
          memberAbsences[memberId] = {
            name: sorted[0].member.name,
            consecutive,
            lastAbsent: lastAbsent!,
          };
        }
      });

      const consecutiveAbsences = Object.entries(memberAbsences).map(([memberId, abs]) => ({
        memberId,
        memberName: abs.name,
        consecutive: abs.consecutive,
      }));

      sendSuccess(res, {
        total,
        present,
        absent,
        late,
        consecutiveAbsences,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

