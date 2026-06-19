import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { validate } from '../middleware/validation';
import { sendSuccess, sendError } from '../utils/response';
import { ValidationError } from '../utils/errors';
import { getStartOfDay, getEndOfDay, getGymTimezone, unpaidInstallmentDisplayBucket, calendarDateStringInGymTZ, startOfGymCalendarDayUtc, startOfNextGymCalendarDayUtc } from '../utils/dateHelpers';
import { getFinancialSummarySchema, getPaymentsReceivedDailySchema, getFeeCollectionsSchema } from '../validations/reports';
import { getFinancialSummary, getPaymentsReceivedDaily } from '../services/reportService';
import {
  getCollectedAmountInDateRange,
  getRecentFeeCollections,
  getRevenueByBillingMonth,
  listFeeCollections,
} from '../services/feeCollectionService';

const router = Router();
const monthKeyRegex = /^\d{4}-\d{2}$/;

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// Aliases for portal probes (same payloads as /api/reports/*)
router.get(
  '/reports/financial-summary',
  validate(getFinancialSummarySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { startDate, endDate, reportMonth } = req.query as {
        startDate: string;
        endDate: string;
        reportMonth: string;
      };
      const data = await getFinancialSummary(gymId, startDate, endDate, reportMonth);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/payments-received-daily',
  validate(getPaymentsReceivedDailySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { startDate, endDate } = req.query as { startDate: string; endDate: string };
      const data = await getPaymentsReceivedDaily(gymId, startDate, endDate);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/fee-collections',
  validate(getFeeCollectionsSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const q = req.query as {
        startDate?: string;
        endDate?: string;
        page?: number;
        limit?: number;
      };
      const pageNum = typeof q.page === 'number' ? q.page : parseInt(String(q.page ?? 1), 10) || 1;
      const limitNum =
        typeof q.limit === 'number' ? q.limit : parseInt(String(q.limit ?? 50), 10) || 50;

      const { rows, total } = await listFeeCollections(gymId, {
        startDate: q.startDate,
        endDate: q.endDate,
        page: pageNum,
        limit: limitNum,
      });

      sendSuccess(res, {
        collections: rows,
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

// GET /api/dashboard/revenue?startMonth=YYYY-MM&endMonth=YYYY-MM
router.get('/revenue', async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;
    const { startMonth, endMonth } = req.query as { startMonth?: string; endMonth?: string };

    if (!startMonth || !endMonth || !monthKeyRegex.test(startMonth) || !monthKeyRegex.test(endMonth)) {
      sendError(res, new ValidationError('startMonth and endMonth are required in YYYY-MM format'));
      return;
    }

    if (startMonth > endMonth) {
      sendError(res, new ValidationError('startMonth must be on or before endMonth'));
      return;
    }

    const revenueByMonthRaw = await getRevenueByBillingMonth(gymId, startMonth, endMonth);

    const [startYear, startM] = startMonth.split('-').map((v) => parseInt(v, 10));
    const [endYear, endM] = endMonth.split('-').map((v) => parseInt(v, 10));

    const filledRevenueByMonth: Record<string, number> = {};
    let year = startYear;
    let month = startM;
    while (year < endYear || (year === endYear && month <= endM)) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      filledRevenueByMonth[key] = revenueByMonthRaw[key] ?? 0;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }

    sendSuccess(res, {
      startMonth,
      endMonth,
      revenueByMonth: filledRevenueByMonth,
      totalRevenue: Object.values(filledRevenueByMonth).reduce((sum, amount) => sum + amount, 0),
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

// GET /api/dashboard/stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;

    const tz = getGymTimezone();
    const todayStr = calendarDateStringInGymTZ(new Date(), tz);
    const monthStartStr = `${todayStr.slice(0, 7)}-01`;

    const [totalCollectedThisMonth, recentCollections, feeCollectionsForChart] = await Promise.all([
      getCollectedAmountInDateRange(
        gymId,
        startOfGymCalendarDayUtc(monthStartStr, tz),
        startOfNextGymCalendarDayUtc(todayStr, tz)
      ),
      getRecentFeeCollections(gymId, 10),
      prisma.feeCollection.findMany({
        where: { gymId, billingMonth: { not: null } },
        select: { billingMonth: true, amount: true },
      }),
    ]);

    // Get basic counts
    const [totalMembers, totalTrainers, allPayments, attendanceRecords] = await Promise.all([
      prisma.member.count({ where: { gymId } }),
      prisma.trainer.count({ where: { gymId } }),
      prisma.payment.findMany({
        where: { gymId },
        select: {
          id: true,
          memberId: true,
          status: true,
          amount: true,
          month: true,
          dueDate: true,
          paidDate: true,
        },
        orderBy: {
          dueDate: 'asc',
        },
      }),
      prisma.attendanceRecord.findMany({
        where: { gymId },
        select: {
          status: true,
          date: true,
        },
      }),
    ]);

    // Calculate payment stats - only count next upcoming payment per member
    // Group payments by member and get only the next upcoming payment for each
    const memberNextPayments = new Map<number, typeof allPayments[0]>();
    
    for (const payment of allPayments) {
      if (payment.status === 'PENDING' || payment.status === 'OVERDUE') {
        const existing = memberNextPayments.get(payment.memberId);
        const earlier =
          !existing ||
          payment.dueDate.getTime() < existing.dueDate.getTime() ||
          (payment.dueDate.getTime() === existing.dueDate.getTime() && payment.id < existing.id);
        if (earlier) {
          memberNextPayments.set(payment.memberId, payment);
        }
      }
    }

    // Same display buckets as member payment UI / financial-summary (gym TZ), not raw DB status
    let pendingPayments = 0;
    let overduePayments = 0;
    for (const p of memberNextPayments.values()) {
      const bucket = unpaidInstallmentDisplayBucket(p.dueDate, tz);
      if (bucket === 'pending') {
        pendingPayments++;
      } else if (bucket === 'overdue') {
        overduePayments++;
      }
    }

    // Calculate attendance summary
    const present = attendanceRecords.filter((r) => r.status === 'PRESENT').length;
    const absent = attendanceRecords.filter((r) => r.status === 'ABSENT').length;

    // Income by billing month from fee collection ledger
    const revenueByMonth: Record<string, number> = {};
    for (const row of feeCollectionsForChart) {
      if (!row.billingMonth) {
        continue;
      }
      revenueByMonth[row.billingMonth] = (revenueByMonth[row.billingMonth] || 0) + row.amount;
    }

    // Calculate attendance trend (last 7 days)
    const today = new Date();
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentAttendance = attendanceRecords.filter(
      (r) => r.date >= sevenDaysAgo && r.date <= today
    );

    const attendanceTrendMap: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      attendanceTrendMap[dateStr] = 0;
    }

    recentAttendance
      .filter((r) => r.status === 'PRESENT')
      .forEach((r) => {
        const dateStr = r.date.toISOString().split('T')[0];
        if (attendanceTrendMap[dateStr] !== undefined) {
          attendanceTrendMap[dateStr]++;
        }
      });

    const attendanceTrend = Object.entries(attendanceTrendMap).map(([date, count]) => ({
      date,
      count,
    }));

    // Calculate workout stats (total present records)
    const workoutStats = present;

    // Calculate currently in gym (members with attendance today)
    const todayStart = getStartOfDay(today);
    const todayEnd = getEndOfDay(today);

    const todayAttendance = await prisma.attendanceRecord.count({
      where: {
        gymId,
        date: {
          gte: todayStart,
          lte: todayEnd,
        },
        status: 'PRESENT',
      },
    });

    sendSuccess(res, {
      totalMembers,
      totalTrainers,
      pendingPayments,
      overduePayments,
      totalCollectedThisMonth,
      recentCollections,
      attendanceSummary: {
        present,
        absent,
      },
      revenueByMonth,
      attendanceTrend,
      workoutStats,
      currentlyInGym: todayAttendance,
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

// GET /api/dashboard/currently-in-gym
router.get('/currently-in-gym', async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;
    const today = new Date();
    const todayStart = getStartOfDay(today);
    const todayEnd = getEndOfDay(today);

    // Get attendance records for today where:
    // - checkInTime exists (member checked in)
    // - checkOutTime is null (member hasn't checked out)
    const records = await prisma.attendanceRecord.findMany({
      where: {
        gymId,
        date: {
          gte: todayStart,
          lte: todayEnd,
        },
        checkInTime: {
          not: null,
        },
        checkOutTime: null,
      },
      include: {
        member: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
      orderBy: {
        checkInTime: 'asc',
      },
    });

    // Format the response
    const membersInGym = records.map((record: any) => {
      const checkInTime = record.checkInTime as Date | null;
      
      // Calculate duration (time since check-in)
      let durationMinutes: number | null = null;
      let durationFormatted: string | null = null;
      
      if (checkInTime) {
        const now = new Date();
        const diffMs = now.getTime() - checkInTime.getTime();
        durationMinutes = Math.round(diffMs / (1000 * 60));
        
        const hours = Math.floor(durationMinutes / 60);
        const minutes = durationMinutes % 60;
        if (hours > 0) {
          durationFormatted = `${hours}h ${minutes}m`;
        } else {
          durationFormatted = `${minutes}m`;
        }
      }

      return {
        memberId: record.member.id,
        memberName: record.member.name,
        contact: record.member.phone || record.member.email || 'N/A',
        checkInTime: checkInTime ? checkInTime.toISOString() : null,
        checkInFormatted: checkInTime
          ? new Date(checkInTime).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : null,
        durationMinutes: durationMinutes,
        durationFormatted: durationFormatted,
        attendanceRecordId: record.id,
      };
    });

    sendSuccess(res, {
      count: membersInGym.length,
      members: membersInGym,
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

export default router;

