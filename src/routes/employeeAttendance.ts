import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import {
  authenticateToken,
  AuthRequest,
  requireGymPermission,
} from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  getEmployeeAttendanceSchema,
  getEmployeeAttendanceRecordSchema,
  getDailyEmployeeAttendanceSchema,
  employeeManualCheckInSchema,
  employeeManualCheckOutSchema,
  markEmployeeAttendanceSchema,
  bulkMarkEmployeeAttendanceSchema,
} from '../validations/employeeAttendance';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError } from '../utils/errors';
import {
  bulkMarkEmployeeAttendance,
  employeeManualCheckIn,
  employeeManualCheckOut,
  formatEmployeeAttendanceRecord,
  getDailyEmployeeAttendance,
  listEmployeeAttendance,
  markEmployeeAttendance,
} from '../services/employeeAttendanceService';

const router = Router();

router.use(authenticateToken);
router.use(requireGymId);

// GET /api/employee-attendance/daily?date=YYYY-MM-DD
// Roster of employees mapped to attendance for one day (primary daily UI).
router.get(
  '/daily',
  requireGymPermission('gym.employeeAttendance.read'),
  validate(getDailyEmployeeAttendanceSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { date, includeInactive } = req.query as {
        date?: string;
        includeInactive?: boolean;
      };
      const data = await getDailyEmployeeAttendance(gymId, date, includeInactive === true);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/employee-attendance/employees — dropdown of employees for filters / check-in
router.get(
  '/employees',
  requireGymPermission('gym.employeeAttendance.read'),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const employees = await prisma.employee.findMany({
        where: { gymId, isActive: true },
        select: {
          id: true,
          employeeNumber: true,
          name: true,
          phone: true,
          email: true,
          designation: true,
          department: true,
        },
        orderBy: { name: 'asc' },
      });

      const options = employees.map((employee) => {
        const employeeNumber = employee.employeeNumber?.trim() || null;
        return {
          id: employee.id,
          employeeNumber,
          name: employee.name,
          designation: employee.designation,
          department: employee.department,
          label: employeeNumber
            ? `${employee.name} (${employeeNumber})`
            : employee.name,
          contact: employee.phone || employee.email || 'N/A',
        };
      });

      sendSuccess(res, { employees: options });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/employee-attendance — historical / filtered list
router.get(
  '/',
  requireGymPermission('gym.employeeAttendance.read'),
  validate(getEmployeeAttendanceSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const {
        employeeId,
        startDate,
        endDate,
        status,
        sortBy,
        sortOrder,
        page,
        limit,
      } = req.query as any;

      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      const data = await listEmployeeAttendance(gymId, {
        employeeId,
        startDate,
        endDate,
        status,
        sortBy,
        sortOrder,
        page: pageNum,
        limit: limitNum,
      });

      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/employee-attendance/manual-check-in
router.post(
  '/manual-check-in',
  requireGymPermission('gym.employeeAttendance.manage'),
  validate(employeeManualCheckInSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { employeeId, checkInTime, status, notes } = req.body;
      const data = await employeeManualCheckIn(gymId, employeeId, new Date(checkInTime), {
        status,
        notes,
      });
      sendSuccess(res, data, undefined, 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/employee-attendance/manual-check-out
router.post(
  '/manual-check-out',
  requireGymPermission('gym.employeeAttendance.manage'),
  validate(employeeManualCheckOutSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { employeeId, checkOutTime, notes } = req.body;
      const record = await employeeManualCheckOut(gymId, employeeId, new Date(checkOutTime), {
        notes,
      });
      sendSuccess(res, { record }, 'Employee checked out');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/employee-attendance/mark — mark/update a single day (PRESENT / ABSENT / LATE)
router.post(
  '/mark',
  requireGymPermission('gym.employeeAttendance.manage'),
  validate(markEmployeeAttendanceSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const record = await markEmployeeAttendance(gymId, req.body);
      sendSuccess(res, { record }, 'Employee attendance saved', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/employee-attendance/daily/bulk — mark many employees for one day
router.post(
  '/daily/bulk',
  requireGymPermission('gym.employeeAttendance.manage'),
  validate(bulkMarkEmployeeAttendanceSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { date, records } = req.body;
      const data = await bulkMarkEmployeeAttendance(gymId, date, records);
      sendSuccess(res, data, 'Daily employee attendance saved', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/employee-attendance/:id
router.get(
  '/:id',
  requireGymPermission('gym.employeeAttendance.read'),
  validate(getEmployeeAttendanceRecordSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = Number(req.params.id);

      const record = await prisma.employeeAttendanceRecord.findFirst({
        where: { id, gymId },
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              name: true,
              phone: true,
              email: true,
              designation: true,
              department: true,
              isActive: true,
            },
          },
        },
      });

      if (!record) {
        sendError(res, new NotFoundError('Employee attendance record', id));
        return;
      }

      sendSuccess(res, formatEmployeeAttendanceRecord(record));
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
