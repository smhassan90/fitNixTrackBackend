import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { sendSuccess, sendError } from '../utils/response';
import { formatMonth } from '../utils/dateHelpers';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/dashboard/stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;

    // Get basic counts
    const [totalMembers, totalTrainers, payments, attendanceRecords] = await Promise.all([
      prisma.member.count({ where: { gymId } }),
      prisma.trainer.count({ where: { gymId } }),
      prisma.payment.findMany({
        where: { gymId },
        select: {
          status: true,
          amount: true,
          month: true,
          paidDate: true,
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

    // Calculate payment stats
    const pendingPayments = payments.filter((p) => p.status === 'PENDING').length;
    const overduePayments = payments.filter((p) => p.status === 'OVERDUE').length;

    // Calculate attendance summary
    const present = attendanceRecords.filter((r) => r.status === 'PRESENT').length;
    const absent = attendanceRecords.filter((r) => r.status === 'ABSENT').length;

    // Calculate revenue by month
    const revenueByMonth: Record<string, number> = {};
    payments
      .filter((p) => p.status === 'PAID' && p.paidDate)
      .forEach((p) => {
        const month = p.month;
        revenueByMonth[month] = (revenueByMonth[month] || 0) + p.amount;
      });

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
    const todayStart = new Date(today);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setUTCHours(23, 59, 59, 999);

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

export default router;

