import { prisma } from '../lib/prisma';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors';
import {
  calendarDateStringInGymTZ,
  formatDateTimeInGymTZ,
  formatTimeInGymTZ,
  getEndOfDay,
  getStartOfDay,
  parseDate,
} from '../utils/dateHelpers';

function attendanceDateForInstant(instant: Date): Date {
  return parseDate(calendarDateStringInGymTZ(instant));
}

function formatDuration(checkInTime: Date | null, checkOutTime: Date | null): {
  duration: number | null;
  durationFormatted: string | null;
} {
  if (checkInTime && checkOutTime) {
    const duration = Math.round((checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60));
    const hours = Math.floor(duration / 60);
    const minutes = duration % 60;
    return {
      duration,
      durationFormatted: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
    };
  }
  if (checkInTime) {
    return { duration: null, durationFormatted: 'In Progress' };
  }
  return { duration: null, durationFormatted: null };
}

export function formatEmployeeAttendanceRecord(record: {
  id: number;
  date: Date;
  status: AttendanceStatus;
  checkInTime: Date | null;
  checkOutTime: Date | null;
  notes: string | null;
  employee: {
    id: number;
    employeeNumber: string | null;
    name: string;
    phone: string | null;
    email: string | null;
    designation: string | null;
    department: string | null;
    isActive: boolean;
  };
}) {
  const checkInTime = record.checkInTime;
  const checkOutTime = record.checkOutTime;
  const { duration, durationFormatted } = formatDuration(checkInTime, checkOutTime);

  return {
    id: record.id,
    date: record.date.toISOString().split('T')[0],
    employeeId: record.employee.id,
    employeeNumber: record.employee.employeeNumber?.trim() || null,
    employee: record.employee.name,
    designation: record.employee.designation,
    department: record.employee.department,
    contact: record.employee.phone || record.employee.email || 'N/A',
    status: record.status,
    checkIn: checkInTime ? formatDateTimeInGymTZ(checkInTime) : null,
    checkOut: checkOutTime ? formatDateTimeInGymTZ(checkOutTime) : null,
    checkInTime,
    checkOutTime,
    duration,
    durationFormatted,
    notes: record.notes,
    employeeDetails: {
      id: record.employee.id,
      employeeNumber: record.employee.employeeNumber?.trim() || null,
      name: record.employee.name,
      phone: record.employee.phone,
      email: record.employee.email,
      designation: record.employee.designation,
      department: record.employee.department,
      isActive: record.employee.isActive,
    },
  };
}

const employeeSelect = {
  id: true,
  employeeNumber: true,
  name: true,
  phone: true,
  email: true,
  designation: true,
  department: true,
  isActive: true,
} satisfies Prisma.EmployeeSelect;

async function resolveActiveEmployee(gymId: number, employeeId: number) {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, gymId },
    select: { id: true, isActive: true, name: true },
  });
  if (!employee) {
    throw new NotFoundError('Employee', employeeId);
  }
  if (!employee.isActive) {
    throw new BadRequestError('Cannot record attendance for an inactive employee');
  }
  return employee;
}

export async function employeeManualCheckIn(
  gymId: number,
  employeeId: number,
  checkInTime: Date,
  options?: { status?: AttendanceStatus; notes?: string | null }
) {
  await resolveActiveEmployee(gymId, employeeId);
  const dateOnly = attendanceDateForInstant(checkInTime);

  const existing = await prisma.employeeAttendanceRecord.findUnique({
    where: {
      gymId_employeeId_date: { gymId, employeeId, date: dateOnly },
    },
  });

  if (existing?.checkInTime && !existing.checkOutTime) {
    throw new ConflictError('Employee is already checked in');
  }

  if (existing?.checkInTime && existing.checkOutTime) {
    throw new ConflictError('Employee has already completed attendance for this date');
  }

  if (existing?.status === 'ABSENT' && !existing.checkInTime) {
    // Replacing a prior ABSENT mark with a real check-in is allowed.
  }

  const record = existing
    ? await prisma.employeeAttendanceRecord.update({
        where: { id: existing.id },
        data: {
          checkInTime,
          checkOutTime: null,
          status: options?.status ?? 'PRESENT',
          notes: options?.notes !== undefined ? options.notes : existing.notes,
        },
        include: { employee: { select: employeeSelect } },
      })
    : await prisma.employeeAttendanceRecord.create({
        data: {
          gymId,
          employeeId,
          date: dateOnly,
          status: options?.status ?? 'PRESENT',
          checkInTime,
          notes: options?.notes ?? null,
        },
        include: { employee: { select: employeeSelect } },
      });

  const checkIn = record.checkInTime!;
  return {
    message: 'Employee checked in successfully.',
    checkInTime: checkIn.toISOString(),
    checkInFormatted: formatTimeInGymTZ(checkIn),
    attendanceRecordId: String(record.id),
    record: formatEmployeeAttendanceRecord(record),
  };
}

export async function employeeManualCheckOut(
  gymId: number,
  employeeId: number,
  checkOutTime: Date,
  options?: { notes?: string | null }
) {
  await resolveActiveEmployee(gymId, employeeId);
  const dateOnly = attendanceDateForInstant(checkOutTime);

  const existing = await prisma.employeeAttendanceRecord.findUnique({
    where: {
      gymId_employeeId_date: { gymId, employeeId, date: dateOnly },
    },
  });

  if (!existing?.checkInTime) {
    throw new BadRequestError('Employee is not checked in for this date');
  }

  if (existing.checkOutTime) {
    throw new ConflictError('Employee is already checked out for this date');
  }

  if (checkOutTime.getTime() < existing.checkInTime.getTime()) {
    throw new BadRequestError('Check-out time cannot be before check-in time');
  }

  const record = await prisma.employeeAttendanceRecord.update({
    where: { id: existing.id },
    data: {
      checkOutTime,
      notes: options?.notes !== undefined ? options.notes : existing.notes,
    },
    include: { employee: { select: employeeSelect } },
  });

  return formatEmployeeAttendanceRecord(record);
}

export async function markEmployeeAttendance(
  gymId: number,
  input: {
    employeeId: number;
    date: string;
    status: AttendanceStatus;
    checkInTime?: string | null;
    checkOutTime?: string | null;
    notes?: string | null;
  }
) {
  await resolveActiveEmployee(gymId, input.employeeId);
  const dateOnly = parseDate(input.date);

  const checkInTime = input.checkInTime ? new Date(input.checkInTime) : null;
  const checkOutTime = input.checkOutTime ? new Date(input.checkOutTime) : null;

  if (checkInTime && checkOutTime && checkOutTime.getTime() < checkInTime.getTime()) {
    throw new BadRequestError('Check-out time cannot be before check-in time');
  }

  if (input.status === 'ABSENT') {
    // Absent days do not keep check-in/out times unless explicitly provided.
  }

  const record = await prisma.employeeAttendanceRecord.upsert({
    where: {
      gymId_employeeId_date: {
        gymId,
        employeeId: input.employeeId,
        date: dateOnly,
      },
    },
    create: {
      gymId,
      employeeId: input.employeeId,
      date: dateOnly,
      status: input.status,
      checkInTime: input.status === 'ABSENT' && !checkInTime ? null : checkInTime,
      checkOutTime: input.status === 'ABSENT' && !checkOutTime ? null : checkOutTime,
      notes: input.notes ?? null,
    },
    update: {
      status: input.status,
      checkInTime: input.checkInTime !== undefined
        ? (input.status === 'ABSENT' && !checkInTime ? null : checkInTime)
        : undefined,
      checkOutTime: input.checkOutTime !== undefined
        ? (input.status === 'ABSENT' && !checkOutTime ? null : checkOutTime)
        : undefined,
      notes: input.notes !== undefined ? input.notes : undefined,
    },
    include: { employee: { select: employeeSelect } },
  });

  return formatEmployeeAttendanceRecord(record);
}

export async function bulkMarkEmployeeAttendance(
  gymId: number,
  date: string,
  records: Array<{
    employeeId: number;
    status: AttendanceStatus;
    checkInTime?: string | null;
    checkOutTime?: string | null;
    notes?: string | null;
  }>
) {
  const employeeIds = [...new Set(records.map((r) => r.employeeId))];
  const employees = await prisma.employee.findMany({
    where: { gymId, id: { in: employeeIds }, isActive: true },
    select: { id: true },
  });
  const activeIds = new Set(employees.map((e) => e.id));

  const missing = employeeIds.filter((id) => !activeIds.has(id));
  if (missing.length > 0) {
    throw new BadRequestError(
      `Unknown or inactive employee id(s): ${missing.join(', ')}`
    );
  }

  const results = [];
  for (const row of records) {
    results.push(
      await markEmployeeAttendance(gymId, {
        employeeId: row.employeeId,
        date,
        status: row.status,
        checkInTime: row.checkInTime,
        checkOutTime: row.checkOutTime,
        notes: row.notes,
      })
    );
  }

  return {
    date,
    marked: results.length,
    records: results,
  };
}

/**
 * Daily roster view: all (active) employees mapped to their attendance for one calendar day.
 */
export async function getDailyEmployeeAttendance(
  gymId: number,
  dateYmd: string | undefined,
  includeInactive = false
) {
  const dateStr = dateYmd ?? calendarDateStringInGymTZ(new Date());
  const dateOnly = parseDate(dateStr);

  const employees = await prisma.employee.findMany({
    where: {
      gymId,
      ...(includeInactive ? {} : { isActive: true }),
    },
    select: {
      ...employeeSelect,
      dateOfJoining: true,
    },
    orderBy: [{ name: 'asc' }],
  });

  const attendanceRows = await prisma.employeeAttendanceRecord.findMany({
    where: { gymId, date: dateOnly },
    include: { employee: { select: employeeSelect } },
  });

  const byEmployeeId = new Map(attendanceRows.map((r) => [r.employeeId, r]));

  const roster = employees.map((employee) => {
    const record = byEmployeeId.get(employee.id);
    if (!record) {
      return {
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber?.trim() || null,
        employee: employee.name,
        designation: employee.designation,
        department: employee.department,
        contact: employee.phone || employee.email || 'N/A',
        isActive: employee.isActive,
        date: dateStr,
        attendanceRecordId: null,
        status: null as AttendanceStatus | null,
        checkIn: null,
        checkOut: null,
        checkInTime: null,
        checkOutTime: null,
        duration: null,
        durationFormatted: null,
        notes: null,
        recorded: false,
      };
    }

    const formatted = formatEmployeeAttendanceRecord(record);
    return {
      employeeId: employee.id,
      employeeNumber: formatted.employeeNumber,
      employee: formatted.employee,
      designation: formatted.designation,
      department: formatted.department,
      contact: formatted.contact,
      isActive: employee.isActive,
      date: dateStr,
      attendanceRecordId: formatted.id,
      status: formatted.status,
      checkIn: formatted.checkIn,
      checkOut: formatted.checkOut,
      checkInTime: formatted.checkInTime,
      checkOutTime: formatted.checkOutTime,
      duration: formatted.duration,
      durationFormatted: formatted.durationFormatted,
      notes: formatted.notes,
      recorded: true,
    };
  });

  const summary = {
    totalEmployees: roster.length,
    recorded: roster.filter((r) => r.recorded).length,
    present: roster.filter((r) => r.status === 'PRESENT').length,
    late: roster.filter((r) => r.status === 'LATE').length,
    absent: roster.filter((r) => r.status === 'ABSENT').length,
    notMarked: roster.filter((r) => !r.recorded).length,
    checkedIn: roster.filter((r) => r.checkInTime && !r.checkOutTime).length,
  };

  return { date: dateStr, summary, roster };
}

export async function listEmployeeAttendance(
  gymId: number,
  filters: {
    employeeId?: number;
    startDate?: string;
    endDate?: string;
    status?: AttendanceStatus;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    page: number;
    limit: number;
  }
) {
  const where: Prisma.EmployeeAttendanceRecordWhereInput = { gymId };

  if (filters.employeeId) {
    where.employeeId = filters.employeeId;
  }
  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.startDate || filters.endDate) {
    where.date = {};
    if (filters.startDate) {
      where.date.gte = getStartOfDay(parseDate(filters.startDate));
    }
    if (filters.endDate) {
      where.date.lte = getEndOfDay(parseDate(filters.endDate));
    }
  }

  const sortBy = filters.sortBy || 'date';
  const sortOrder = filters.sortOrder || 'desc';
  const allowedSort = new Set(['date', 'checkInTime', 'checkOutTime', 'status', 'createdAt']);
  const orderField = allowedSort.has(sortBy) ? sortBy : 'date';

  const total = await prisma.employeeAttendanceRecord.count({ where });
  const records = await prisma.employeeAttendanceRecord.findMany({
    where,
    include: { employee: { select: employeeSelect } },
    orderBy: { [orderField]: sortOrder },
    skip: (filters.page - 1) * filters.limit,
    take: filters.limit,
  });

  return {
    records: records.map(formatEmployeeAttendanceRecord),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit),
    },
  };
}
