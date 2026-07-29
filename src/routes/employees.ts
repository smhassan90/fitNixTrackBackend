import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { validate } from '../middleware/validation';
import {
  authenticateToken,
  AuthRequest,
  requireGymPermission,
} from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  getEmployeesSchema,
  getEmployeeSchema,
  deleteEmployeeSchema,
  deactivateEmployeeSchema,
  activateEmployeeSchema,
} from '../validations/employees';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';
import { parseDate, startOfGymCalendarDayUtc, startOfNextGymCalendarDayUtc } from '../utils/dateHelpers';
import { normalizeEmailOrNull } from '../services/mobileGoogleAuthService';

const router = Router();

function isEmployeeUniqueViolation(error: unknown, field: 'email' | 'employeeNumber'): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as string[]).some((t) => String(t).includes(field))
  );
}

function normalizeOptionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

router.use(authenticateToken);
router.use(requireGymId);

// GET /api/employees
router.get(
  '/',
  requireGymPermission('gym.employees.read'),
  validate(getEmployeesSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const {
        search,
        designation,
        department,
        sortBy = 'name',
        sortOrder = 'asc',
        page,
        limit,
        createdFrom,
        createdTo,
        isActive,
      } = req.query as any;

      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

      const where: Prisma.EmployeeWhereInput = { gymId };

      if (isActive !== undefined) {
        where.isActive = isActive;
      }
      if (designation) {
        where.designation = { contains: designation };
      }
      if (department) {
        where.department = { contains: department };
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

      if (search) {
        const searchNum = parseInt(search, 10);
        where.OR = [
          { name: { contains: search } },
          { phone: { contains: search } },
          { email: { contains: search } },
          { employeeNumber: { contains: search } },
          { designation: { contains: search } },
          { department: { contains: search } },
          ...(Number.isNaN(searchNum) ? [] : [{ id: searchNum }]),
        ];
      }

      const allowedSort = new Set([
        'name',
        'createdAt',
        'updatedAt',
        'dateOfJoining',
        'designation',
        'employeeNumber',
      ]);
      const orderField = allowedSort.has(sortBy) ? sortBy : 'name';

      const total = await prisma.employee.count({ where });
      const employees = await prisma.employee.findMany({
        where,
        include: {
          _count: { select: { attendanceRecords: true } },
        },
        orderBy: { [orderField]: sortOrder },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      });

      sendSuccess(res, {
        employees,
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

// GET /api/employees/:id
router.get(
  '/:id',
  requireGymPermission('gym.employees.read'),
  validate(getEmployeeSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = Number(req.params.id);

      const employee = await prisma.employee.findFirst({
        where: { id, gymId },
        include: {
          _count: { select: { attendanceRecords: true } },
        },
      });

      if (!employee) {
        sendError(res, new NotFoundError('Employee', id));
        return;
      }

      sendSuccess(res, employee);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/employees
router.post(
  '/',
  requireGymPermission('gym.employees.manage'),
  validate(createEmployeeSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const {
        name,
        employeeNumber,
        phone,
        email,
        gender,
        dateOfBirth,
        designation,
        department,
        dateOfJoining,
        salary,
        notes,
        isActive,
      } = req.body;

      const employee = await prisma.employee.create({
        data: {
          gymId,
          name: String(name).trim(),
          employeeNumber: normalizeOptionalText(employeeNumber),
          phone: normalizeOptionalText(phone),
          email: normalizeEmailOrNull(email),
          gender: gender || null,
          dateOfBirth: dateOfBirth ? parseDate(dateOfBirth) : null,
          designation: normalizeOptionalText(designation),
          department: normalizeOptionalText(department),
          dateOfJoining: dateOfJoining ? parseDate(dateOfJoining) : null,
          salary: salary ?? null,
          notes: normalizeOptionalText(notes),
          isActive: isActive ?? true,
        },
        include: {
          _count: { select: { attendanceRecords: true } },
        },
      });

      sendSuccess(res, employee, 'Employee created successfully', 201);
    } catch (error) {
      if (isEmployeeUniqueViolation(error, 'email')) {
        sendError(res, new ValidationError('An employee with this email already exists in this gym'));
        return;
      }
      if (isEmployeeUniqueViolation(error, 'employeeNumber')) {
        sendError(res, new ValidationError('An employee with this employee number already exists in this gym'));
        return;
      }
      sendError(res, error as Error);
    }
  }
);

async function updateEmployeeHandler(req: AuthRequest, res: Response) {
  try {
    const gymId = req.gymId!;
    const id = Number(req.params.id);
    const {
      name,
      employeeNumber,
      phone,
      email,
      gender,
      dateOfBirth,
      designation,
      department,
      dateOfJoining,
      salary,
      notes,
      isActive,
    } = req.body;

    const existing = await prisma.employee.findFirst({
      where: { id, gymId },
    });

    if (!existing) {
      sendError(res, new NotFoundError('Employee', id));
      return;
    }

    const updateData: Prisma.EmployeeUpdateInput = {};
    if (name !== undefined) updateData.name = String(name).trim();
    if (employeeNumber !== undefined) updateData.employeeNumber = normalizeOptionalText(employeeNumber);
    if (phone !== undefined) updateData.phone = normalizeOptionalText(phone);
    if (email !== undefined) updateData.email = normalizeEmailOrNull(email);
    if (gender !== undefined) updateData.gender = gender;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth ? parseDate(dateOfBirth) : null;
    if (designation !== undefined) updateData.designation = normalizeOptionalText(designation);
    if (department !== undefined) updateData.department = normalizeOptionalText(department);
    if (dateOfJoining !== undefined) {
      updateData.dateOfJoining = dateOfJoining ? parseDate(dateOfJoining) : null;
    }
    if (salary !== undefined) updateData.salary = salary;
    if (notes !== undefined) updateData.notes = normalizeOptionalText(notes);
    if (isActive !== undefined) updateData.isActive = isActive;

    const employee = await prisma.employee.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { attendanceRecords: true } },
      },
    });

    sendSuccess(res, employee, 'Employee updated successfully');
  } catch (error) {
    if (isEmployeeUniqueViolation(error, 'email')) {
      sendError(res, new ValidationError('An employee with this email already exists in this gym'));
      return;
    }
    if (isEmployeeUniqueViolation(error, 'employeeNumber')) {
      sendError(res, new ValidationError('An employee with this employee number already exists in this gym'));
      return;
    }
    sendError(res, error as Error);
  }
}

router.put(
  '/:id',
  requireGymPermission('gym.employees.manage'),
  validate(updateEmployeeSchema),
  updateEmployeeHandler
);

router.patch(
  '/:id',
  requireGymPermission('gym.employees.manage'),
  validate(updateEmployeeSchema),
  updateEmployeeHandler
);

router.patch(
  '/:id/deactivate',
  requireGymPermission('gym.employees.manage'),
  validate(deactivateEmployeeSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = Number(req.params.id);

      const employee = await prisma.employee.findFirst({ where: { id, gymId } });
      if (!employee) {
        sendError(res, new NotFoundError('Employee', id));
        return;
      }
      if (!employee.isActive) {
        sendError(res, new ValidationError('Employee is already inactive'));
        return;
      }

      const updated = await prisma.employee.update({
        where: { id },
        data: { isActive: false },
        include: { _count: { select: { attendanceRecords: true } } },
      });

      sendSuccess(res, updated, 'Employee deactivated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id/activate',
  requireGymPermission('gym.employees.manage'),
  validate(activateEmployeeSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = Number(req.params.id);

      const employee = await prisma.employee.findFirst({ where: { id, gymId } });
      if (!employee) {
        sendError(res, new NotFoundError('Employee', id));
        return;
      }
      if (employee.isActive) {
        sendError(res, new ValidationError('Employee is already active'));
        return;
      }

      const updated = await prisma.employee.update({
        where: { id },
        data: { isActive: true },
        include: { _count: { select: { attendanceRecords: true } } },
      });

      sendSuccess(res, updated, 'Employee activated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/:id',
  requireGymPermission('gym.employees.delete'),
  validate(deleteEmployeeSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = Number(req.params.id);

      const employee = await prisma.employee.findFirst({
        where: { id, gymId },
        include: { _count: { select: { attendanceRecords: true } } },
      });

      if (!employee) {
        sendError(res, new NotFoundError('Employee', id));
        return;
      }

      await prisma.employee.delete({ where: { id } });
      sendSuccess(res, {
        message: 'Employee deleted successfully',
        deletedAttendanceRecords: employee._count.attendanceRecords,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
