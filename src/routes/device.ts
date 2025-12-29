import { Router, Response } from 'express';
import { prisma, retryDatabaseOperation } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  createDeviceConfigSchema,
  updateDeviceConfigSchema,
  getDeviceConfigSchema,
  deleteDeviceConfigSchema,
  testDeviceConnectionSchema,
  syncAttendanceSchema,
  syncUsersSchema,
  createUserMappingSchema,
  updateUserMappingSchema,
  deleteUserMappingSchema,
  getUserMappingsSchema,
  getDeviceAttendanceLogsSchema,
} from '../validations/device';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { ZKTService, syncAttendanceFromDevice, syncUsersFromDevice, autoCheckoutIncompleteRecords } from '../services/zktService';
import { parseDate } from '../utils/dateHelpers';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// ============ Device Configuration Routes ============

// GET /api/device - Get all device configurations for the gym
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;

    const devices = await prisma.deviceConfig.findMany({
      where: { gymId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { userMappings: true },
        },
      },
    });

    sendSuccess(res, devices);
  } catch (error) {
    sendError(res, error as Error);
  }
});

// POST /api/device - Create a new device configuration
router.post(
  '/',
  validate(createDeviceConfigSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { name, ipAddress, port, serialNumber, syncInterval, deviceUserId, devicePassword } = req.body;

      // Check if device with same IP and port already exists
      const existing = await prisma.deviceConfig.findUnique({
        where: {
          gymId_ipAddress_port: {
            gymId,
            ipAddress,
            port: port || 4370,
          },
        },
      });

      if (existing) {
        sendError(res, new BadRequestError('Device with this IP and port already exists'));
        return;
      }

      const device = await prisma.deviceConfig.create({
        data: {
          gymId,
          name,
          ipAddress,
          port: port || 4370,
          serialNumber,
          syncInterval: syncInterval || 300,
          deviceUserId,
          devicePassword,
        },
      });

      sendSuccess(res, device, undefined, 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/device/:id/test - Test device connection
// NOTE: More specific routes must come before /:id route
router.post(
  '/:id/test',
  validate(testDeviceConnectionSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      const zktService = new ZKTService({
        ip: device.ipAddress,
        port: device.port,
      });

      const isConnected = await zktService.testConnection();

      sendSuccess(res, {
        connected: isConnected,
        message: isConnected
          ? 'Device connection successful'
          : 'Failed to connect to device. Please check IP address, port, and network connectivity.',
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/device/:id/attendance-logs - Fetch attendance logs from device and save to database (incremental sync)
router.get(
  '/:id/attendance-logs',
  validate(getDeviceAttendanceLogsSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const { startDate, endDate, fullSync } = req.query as any;

      // Use retry logic for database connection issues
      const device = await retryDatabaseOperation(
        () => prisma.deviceConfig.findFirst({
          where: { id, gymId },
          include: {
            userMappings: {
              where: { isActive: true },
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
            },
          },
        }),
        3, // max retries
        1000 // initial delay 1 second
      );

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      // Create ZKTService instance with device config
      const zktService = new ZKTService({
        ip: device.ipAddress,
        port: device.port,
      });

      // Connect to device
      const connected = await zktService.connect();
      if (!connected) {
        sendError(res, new Error('Failed to connect to device'));
        return;
      }

      try {
        // Get attendance logs from device
        const logs = await zktService.getAttendanceLogs();

        // Create a map of device user ID to member ID
        const deviceUserToMemberMap = new Map<string, number>();
        const deviceUserToMemberInfoMap = new Map<string, any>();
        device.userMappings.forEach((mapping) => {
          deviceUserToMemberMap.set(mapping.deviceUserId, mapping.member.id);
          deviceUserToMemberInfoMap.set(mapping.deviceUserId, {
            memberId: mapping.member.id,
            memberName: mapping.member.name,
            memberEmail: mapping.member.email,
            memberPhone: mapping.member.phone,
          });
        });

        // Determine the start time for incremental sync
        // If fullSync=true, delete all existing records and fetch all records from device
        // If lastSyncAt exists and fullSync is not true, only fetch logs after that time
        // Otherwise, use provided startDate or fetch all
        let syncStartTime: Date | undefined;
        let deletedRecordsCount = 0;
        
        if (fullSync === true) {
          // Force full sync - delete all existing attendance records and fetch fresh from device
          console.log(`Full sync requested: clearing attendance table and fetching all logs from device`);
          
          // Delete ALL attendance records for this gym (including manually created ones)
          // This ensures a clean slate before re-syncing from device
          const deleteResult = await prisma.attendanceRecord.deleteMany({
            where: {
              gymId,
            },
          });
          
          deletedRecordsCount = deleteResult.count;
          console.log(`Deleted ${deletedRecordsCount} attendance records for full sync (all records for gym cleared)`);
          
          if (startDate) {
            syncStartTime = parseDate(startDate);
            console.log(`Using provided startDate: ${syncStartTime.toISOString()}`);
          } else {
            syncStartTime = undefined; // Fetch all
          }
        } else if (device.lastSyncAt) {
          syncStartTime = device.lastSyncAt;
          console.log(`Incremental sync: fetching logs after ${syncStartTime.toISOString()}`);
        } else if (startDate) {
          syncStartTime = parseDate(startDate);
        }

        // Parse end date if provided
        const syncEndTime = endDate ? parseDate(endDate) : undefined;

        // Filter logs: only process new logs since last sync
        // Group logs by member and date to ensure one record per member per date
        const logsByMemberAndDate = new Map<string, {
          memberId: number;
          date: Date;
          checkIns: Date[];
          checkOuts: Date[];
          deviceUserId: string;
          memberInfo: any;
        }>();

        for (const log of logs) {
          // Handle both timestamp formats
          let logDate: Date;
          if (log.recordTime) {
            logDate = new Date(log.recordTime);
          } else if (log.timestamp) {
            logDate = new Date(log.timestamp * 1000);
          } else {
            continue; // Skip logs without timestamp
          }
          
          // Validate date
          if (isNaN(logDate.getTime())) {
            continue;
          }
          
          // If we have a sync start time, only include logs after it
          if (syncStartTime && logDate <= syncStartTime) {
            continue;
          }
          
          // Filter by date range if provided
          if (syncEndTime && logDate > syncEndTime) {
            continue;
          }

          // Get device user ID
          let deviceUserId: string | null = null;
          if (log.deviceUserId !== undefined && log.deviceUserId !== null) {
            deviceUserId = log.deviceUserId.toString();
          } else if (log.id !== undefined && log.id !== null) {
            deviceUserId = log.id.toString();
          } else if (log.uid !== undefined && log.uid !== null) {
            deviceUserId = log.uid.toString();
          }

          if (!deviceUserId) {
            continue;
          }

          const memberId = deviceUserToMemberMap.get(deviceUserId);
          if (!memberId) {
            continue; // Skip unmapped users
          }

          // Determine if this is check-in or check-out first
          let isCheckIn: boolean;
          if (log.type !== undefined || log.state !== undefined) {
            // Old format: type 0 = Check-in, type 1 = Check-out
            isCheckIn = log.type === 0 || (log.type === undefined && log.state === 0);
          } else {
            // For new format, we'll determine this after grouping by checking existing logs
            // For now, we'll group all logs together and determine check-in/check-out later
            isCheckIn = true; // Temporary, will be adjusted during grouping
          }

          // The date field should be based on the check-in time's date (or check-out if no check-in)
          // For now, use the log's date, but we'll recalculate based on actual check-in time later
          const logYear = logDate.getFullYear();
          const logMonth = logDate.getMonth();
          const logDay = logDate.getDate();
          
          // Create a key for grouping: memberId + date of the log
          // We'll adjust the date later based on the actual check-in time
          const key = `${memberId}_${logYear}-${logMonth + 1}-${logDay}`;

          if (!logsByMemberAndDate.has(key)) {
            logsByMemberAndDate.set(key, {
              memberId,
              date: new Date(logYear, logMonth, logDay), // Will be recalculated based on check-in
              checkIns: [],
              checkOuts: [],
              deviceUserId,
              memberInfo: deviceUserToMemberInfoMap.get(deviceUserId),
            });
          }

          const group = logsByMemberAndDate.get(key)!;
          
          // Re-determine check-in/check-out if format is new (no type/state)
          if (log.type === undefined && log.state === undefined) {
            if (group.checkIns.length === 0 && group.checkOuts.length === 0) {
              // First log for this group - treat as check-in
              isCheckIn = true;
            } else if (group.checkIns.length === 0) {
              // No check-in yet, but has check-out - this must be check-in
              isCheckIn = true;
            } else if (group.checkOuts.length === 0) {
              // Has check-in but no check-out - this is check-out if later than check-in
              isCheckIn = logDate <= group.checkIns[0];
            } else {
              // Has both - compare times: earlier is check-in, later is check-out
              isCheckIn = logDate < group.checkIns[0];
            }
          }

          if (isCheckIn) {
            group.checkIns.push(logDate);
          } else {
            group.checkOuts.push(logDate);
          }
        }

        // Convert grouped logs to array for processing
        const groupedLogs = Array.from(logsByMemberAndDate.values());

        console.log(`Found ${logs.length} total logs, grouped into ${groupedLogs.length} unique member-date combinations`);

        let synced = 0;
        let errors = 0;
        const formattedLogs: any[] = [];

        // Process each grouped log (one record per member per date)
        for (const group of groupedLogs) {
          try {
            const { memberId, checkIns, checkOuts, deviceUserId, memberInfo } = group;

            // Skip if there are no check-ins or check-outs - device sync should only create records with actual timestamps
            if (checkIns.length === 0 && checkOuts.length === 0) {
              console.warn(`Skipping group for member ${memberId}: no check-in or check-out timestamps`);
              continue;
            }

            // Get earliest check-in and latest check-out for this date
            const earliestCheckIn = checkIns.length > 0 ? new Date(Math.min(...checkIns.map(d => d.getTime()))) : null;
            const latestCheckOut = checkOuts.length > 0 ? new Date(Math.max(...checkOuts.map(d => d.getTime()))) : null;

            // The date field should be the calendar date of the check-in time (or check-out if no check-in)
            // This ensures the date matches the actual attendance date
            const attendanceDate = earliestCheckIn || latestCheckOut;
            if (!attendanceDate) {
              console.warn(`Skipping group for member ${memberId}: no valid attendance date`);
              continue;
            }

            // Use the date of the check-in (or check-out if no check-in) for the record date
            // Use UTC methods to ensure consistent date calculation regardless of server timezone
            const year = attendanceDate.getUTCFullYear();
            const month = attendanceDate.getUTCMonth();
            const day = attendanceDate.getUTCDate();
            
            // Normalize date to YYYY-MM-DD format for MySQL DATE field (UTC midnight)
            const monthStr = String(month + 1).padStart(2, '0');
            const dayStr = String(day).padStart(2, '0');
            const dateOnly = new Date(`${year}-${monthStr}-${dayStr}T00:00:00.000Z`);
            
            // For comparison purposes, create a local date object
            const recordDate = new Date(year, month, day);

            // Ensure we have at least one timestamp (check-in or check-out) before creating a record
            if (!earliestCheckIn && !latestCheckOut) {
              console.warn(`Skipping record creation for member ${memberId} on ${recordDate.toISOString().split('T')[0]}: no valid timestamps`);
              continue;
            }

            // Always check for and fix date mismatches before processing
            // Find any records for this member where DATE(checkInTime) matches our target date
            // but the date field is different (mismatch)
            if (earliestCheckIn || latestCheckOut) {
              // Get all records for this member to check for mismatches
              const allMemberRecords = await prisma.attendanceRecord.findMany({
                where: {
                  gymId,
                  memberId,
                  OR: [
                    { checkInTime: { not: null } },
                    { checkOutTime: { not: null } },
                  ],
                },
              });

              // Find and delete records with date mismatches
              for (const record of allMemberRecords) {
                let recordCheckInDate: Date | null = null;
                
                // Determine the correct date from check-in or check-out
                if (record.checkInTime) {
                  recordCheckInDate = new Date(record.checkInTime);
                } else if (record.checkOutTime) {
                  recordCheckInDate = new Date(record.checkOutTime);
                }

                if (recordCheckInDate) {
                  // Use UTC methods for consistent date comparison
                  const recordCheckInYear = recordCheckInDate.getUTCFullYear();
                  const recordCheckInMonth = recordCheckInDate.getUTCMonth();
                  const recordCheckInDay = recordCheckInDate.getUTCDate();
                  
                  // Check if this record's check-in/check-out date matches our target date
                  if (recordCheckInYear === year && recordCheckInMonth === month && recordCheckInDay === day) {
                    // But the date field is different - this is a mismatch
                    const recordDate = new Date(record.date);
                    const recordDateYear = recordDate.getUTCFullYear();
                    const recordDateMonth = recordDate.getUTCMonth();
                    const recordDateDay = recordDate.getUTCDate();
                    
                    if (recordDateYear !== year || recordDateMonth !== month || recordDateDay !== day) {
                      // Date mismatch detected - delete the old record
                      console.log(`Fixing date mismatch: record ${record.id} has date=${record.date.toISOString().split('T')[0]}, but check-in/check-out is on ${dateOnly.toISOString().split('T')[0]}. Deleting old record.`);
                      await prisma.attendanceRecord.delete({
                        where: { id: record.id },
                      });
                      deletedRecordsCount++; // Track deletions for mismatch fixes
                    }
                  }
                }
              }
            }

            // Now check for record with correct date (after cleaning up mismatches)
            let existingRecord = await prisma.attendanceRecord.findUnique({
              where: {
                gymId_memberId_date: {
                  gymId,
                  memberId,
                  date: dateOnly, // Correct date based on check-in time
                },
              },
            });

            let wasUpdated = false;
            let finalRecord;
            let isNewRecord = false;

            try {
              if (!existingRecord) {
                // Only create new record if we have at least one timestamp from device
                // Device sync should never create records without check-in or check-out times
                if (!earliestCheckIn && !latestCheckOut) {
                  console.warn(`Skipping record creation for member ${memberId} on ${recordDate.toISOString().split('T')[0]}: no device timestamps`);
                  continue;
                }

                // Create new record with earliest check-in and latest check-out
                try {
                  finalRecord = await prisma.attendanceRecord.create({
                    data: {
                      gymId,
                      memberId,
                      date: dateOnly, // Correct date based on check-in time
                      status: 'PRESENT',
                      checkInTime: earliestCheckIn || undefined,
                      checkOutTime: latestCheckOut || undefined,
                      deviceUserId,
                      deviceSerialNumber: device.serialNumber || undefined,
                    },
                  });
                  wasUpdated = true;
                  isNewRecord = true;
                  synced++;
                } catch (createError: any) {
                  // If create fails with unique constraint, fetch and update instead
                  if (createError?.code === 'P2002') {
                    existingRecord = await prisma.attendanceRecord.findUnique({
                      where: {
                        gymId_memberId_date: {
                          gymId,
                          memberId,
                          date: dateOnly,
                        },
                      },
                    });
                  } else {
                    throw createError;
                  }
                }
              }

              // Update existing record if needed
              if (existingRecord) {

                const updateData: any = {
                  deviceUserId,
                  deviceSerialNumber: device.serialNumber || undefined,
                  status: 'PRESENT',
                };

                // Update check-in time: use earliest of existing or new check-ins
                if (earliestCheckIn) {
                  if (!existingRecord.checkInTime || earliestCheckIn < existingRecord.checkInTime) {
                    updateData.checkInTime = earliestCheckIn;
                    wasUpdated = true;
                  } else {
                    updateData.checkInTime = existingRecord.checkInTime;
                  }
                } else if (existingRecord.checkInTime) {
                  updateData.checkInTime = existingRecord.checkInTime;
                }

                // Update check-out time: use latest of existing or new check-outs
                if (latestCheckOut) {
                  if (!existingRecord.checkOutTime || latestCheckOut > existingRecord.checkOutTime) {
                    updateData.checkOutTime = latestCheckOut;
                    wasUpdated = true;
                  } else {
                    updateData.checkOutTime = existingRecord.checkOutTime;
                  }
                } else if (existingRecord.checkOutTime) {
                  updateData.checkOutTime = existingRecord.checkOutTime;
                }

                if (wasUpdated) {
                  finalRecord = await prisma.attendanceRecord.update({
                    where: { id: existingRecord.id },
                    data: updateData,
                  });
                  synced++;
                } else {
                  finalRecord = existingRecord;
                }
              }

              // Add formatted logs for response (one entry per check-in/check-out)
              if (wasUpdated || isNewRecord) {
                // Add check-in entry
                if (earliestCheckIn) {
                  formattedLogs.push({
                    uid: null,
                    deviceUserId: deviceUserId,
                    eventType: 'CHECK_IN',
                    timestamp: Math.floor(earliestCheckIn.getTime() / 1000),
                    recordTime: earliestCheckIn.toISOString(),
                    dateTime: earliestCheckIn.toISOString(),
                    date: recordDate.toISOString().split('T')[0],
                    time: earliestCheckIn.toTimeString().split(' ')[0],
                    type: null,
                    state: null,
                    member: memberInfo || null,
                  });
                }

                // Add check-out entry
                if (latestCheckOut) {
                  formattedLogs.push({
                    uid: null,
                    deviceUserId: deviceUserId,
                    eventType: 'CHECK_OUT',
                    timestamp: Math.floor(latestCheckOut.getTime() / 1000),
                    recordTime: latestCheckOut.toISOString(),
                    dateTime: latestCheckOut.toISOString(),
                    date: recordDate.toISOString().split('T')[0],
                    time: latestCheckOut.toTimeString().split(' ')[0],
                    type: null,
                    state: null,
                    member: memberInfo || null,
                  });
                }
              }
            } catch (error: any) {
              console.error(`Error processing attendance record for member ${memberId} on ${dateOnly.toISOString()}:`, error);
              errors++;
              continue;
            }
          } catch (error) {
            console.error(`Error processing grouped log entry:`, error);
            errors++;
          }
        }

        // Update last sync time to current time
        const newLastSyncAt = new Date();
        await prisma.deviceConfig.update({
          where: { id },
          data: { lastSyncAt: newLastSyncAt },
        });

        // Auto-checkout members who checked in on previous dates but didn't check out
        await autoCheckoutIncompleteRecords(gymId);

        // Separate check-ins and check-outs
        const checkIns = formattedLogs.filter((log) => log.eventType === 'CHECK_IN');
        const checkOuts = formattedLogs.filter((log) => log.eventType === 'CHECK_OUT');

        sendSuccess(res, {
          total: formattedLogs.length,
          checkIns: checkIns.length,
          checkOuts: checkOuts.length,
          synced,
          errors,
          deleted: deletedRecordsCount, // Number of records deleted in full sync
          logs: formattedLogs.sort((a, b) => b.timestamp - a.timestamp),
          summary: {
            totalRecords: formattedLogs.length,
            checkInsCount: checkIns.length,
            checkOutsCount: checkOuts.length,
            syncedCount: synced,
            errorCount: errors,
            deletedCount: deletedRecordsCount,
            lastSyncAt: newLastSyncAt.toISOString(),
            previousSyncAt: device.lastSyncAt ? device.lastSyncAt.toISOString() : null,
            dateRange: {
              start: syncStartTime ? syncStartTime.toISOString().split('T')[0] : null,
              end: syncEndTime ? syncEndTime.toISOString().split('T')[0] : null,
            },
            isFullSync: fullSync === true,
          },
        });
      } finally {
        await zktService.disconnect();
      }
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/device/:id/sync-attendance - Sync attendance from device
router.post(
  '/:id/sync-attendance',
  validate(syncAttendanceSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const { startDate, endDate } = req.query as any;

      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      const start = startDate ? parseDate(startDate) : undefined;
      const end = endDate ? parseDate(endDate) : undefined;

      const result = await syncAttendanceFromDevice(id, gymId, start, end);

      sendSuccess(res, {
        ...result,
        message: `Synced ${result.synced} attendance records. ${result.errors} errors encountered.`,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/device/:id/sync-users - Sync users from device
router.post(
  '/:id/sync-users',
  validate(syncUsersSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      const result = await syncUsersFromDevice(id, gymId);

      // Get existing mappings to identify unmapped device users
      const existingMappings = await prisma.deviceUserMapping.findMany({
        where: {
          deviceConfigId: id,
          isActive: true,
        },
        select: {
          deviceUserId: true,
        },
      });

      const mappedDeviceUserIds = new Set(existingMappings.map((m) => m.deviceUserId));
      const unmappedDeviceUsers = result.users.filter(
        (user) => !mappedDeviceUserIds.has(user.uid.toString())
      );

      sendSuccess(res, {
        ...result,
        unmappedDeviceUsers: unmappedDeviceUsers.map((u) => ({
          uid: u.uid,
          name: u.name,
          userId: u.userId,
        })),
        unmappedCount: unmappedDeviceUsers.length,
        message: `Found ${result.users.length} users on device. Mapped ${result.mapped} users to members. ${unmappedDeviceUsers.length} users remain unmapped.`,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/device/:id - Get device configuration by ID
router.get(
  '/:id',
  validate(getDeviceConfigSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
        include: {
          _count: {
            select: { userMappings: true },
          },
        },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      sendSuccess(res, device);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PUT /api/device/:id - Update device configuration
router.put(
  '/:id',
  validate(updateDeviceConfigSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const updateData = req.body;

      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      // If IP or port is being updated, check for duplicates
      if (updateData.ipAddress || updateData.port) {
        const newIp = updateData.ipAddress || device.ipAddress;
        const newPort = updateData.port || device.port;

        const existing = await prisma.deviceConfig.findUnique({
          where: {
            gymId_ipAddress_port: {
              gymId,
              ipAddress: newIp,
              port: newPort,
            },
          },
        });

        if (existing && existing.id !== id) {
          sendError(res, new BadRequestError('Device with this IP and port already exists'));
          return;
        }
      }

      const updated = await prisma.deviceConfig.update({
        where: { id },
        data: updateData,
      });

      sendSuccess(res, updated);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/device/:id - Delete device configuration
router.delete(
  '/:id',
  validate(deleteDeviceConfigSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      await prisma.deviceConfig.delete({
        where: { id },
      });

      sendSuccess(res, { message: 'Device configuration deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// ============ User Mapping Routes ============

// GET /api/device/:id/unmapped-members - Get members without device mappings
router.get(
  '/:id/unmapped-members',
  validate(getDeviceConfigSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      // Verify device belongs to gym
      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      // Get all members for this gym
      const allMembers = await prisma.member.findMany({
        where: { gymId },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      });

      // Get all mapped member IDs for this device
      const mappedMembers = await prisma.deviceUserMapping.findMany({
        where: {
          deviceConfigId: id,
          isActive: true,
        },
        select: {
          memberId: true,
        },
      });

      const mappedMemberIds = new Set(mappedMembers.map((m) => m.memberId));

      // Filter out mapped members
      const unmappedMembers = allMembers.filter((member) => !mappedMemberIds.has(member.id));

      sendSuccess(res, {
        unmappedMembers,
        total: unmappedMembers.length,
        totalMembers: allMembers.length,
        mappedMembers: mappedMemberIds.size,
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/device/:id/mappings - Get user mappings for a device
router.get(
  '/:id/mappings',
  validate(getUserMappingsSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const { memberId, isActive } = req.query as any;

      // Verify device belongs to gym
      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      const where: any = { deviceConfigId: id };
      if (memberId) {
        where.memberId = memberId;
      }
      if (isActive !== undefined) {
        where.isActive = isActive;
      }

      const mappings = await prisma.deviceUserMapping.findMany({
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
        orderBy: { createdAt: 'desc' },
      });

      sendSuccess(res, mappings);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/device/:id/mappings - Create user mapping
router.post(
  '/:id/mappings',
  validate(createUserMappingSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const { memberId, deviceUserId, deviceUserName } = req.body;

      // Verify device belongs to gym
      const device = await prisma.deviceConfig.findFirst({
        where: { id, gymId },
      });

      if (!device) {
        sendError(res, new NotFoundError('Device configuration', id));
        return;
      }

      // Verify member belongs to gym
      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', memberId.toString()));
        return;
      }

      // Check if mapping already exists
      const existing = await prisma.deviceUserMapping.findUnique({
        where: {
          deviceConfigId_deviceUserId: {
            deviceConfigId: id,
            deviceUserId,
          },
        },
      });

      if (existing) {
        sendError(res, new BadRequestError('Mapping for this device user already exists'));
        return;
      }

      const mapping = await prisma.deviceUserMapping.create({
        data: {
          deviceConfigId: id,
          memberId,
          deviceUserId,
          deviceUserName,
        },
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

      sendSuccess(res, mapping, undefined, 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PUT /api/device/mappings/:id - Update user mapping
router.put(
  '/mappings/:id',
  validate(updateUserMappingSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;
      const updateData = req.body;

      const mapping = await prisma.deviceUserMapping.findFirst({
        where: { id },
        include: {
          deviceConfig: true,
        },
      });

      if (!mapping) {
        sendError(res, new NotFoundError('User mapping', id));
        return;
      }

      if (mapping.deviceConfig.gymId !== gymId) {
        sendError(res, new NotFoundError('User mapping', id));
        return;
      }

      // If memberId is being updated, verify it belongs to gym
      if (updateData.memberId) {
        const member = await prisma.member.findFirst({
          where: { id: updateData.memberId, gymId },
        });

        if (!member) {
          sendError(res, new NotFoundError('Member', updateData.memberId.toString()));
          return;
        }
      }

      const updated = await prisma.deviceUserMapping.update({
        where: { id },
        data: updateData,
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

      sendSuccess(res, updated);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/device/mappings/:id - Delete user mapping
router.delete(
  '/mappings/:id',
  validate(deleteUserMappingSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { id } = req.params;

      const mapping = await prisma.deviceUserMapping.findFirst({
        where: { id },
        include: {
          deviceConfig: true,
        },
      });

      if (!mapping) {
        sendError(res, new NotFoundError('User mapping', id));
        return;
      }

      if (mapping.deviceConfig.gymId !== gymId) {
        sendError(res, new NotFoundError('User mapping', id));
        return;
      }

      await prisma.deviceUserMapping.delete({
        where: { id },
      });

      sendSuccess(res, { message: 'User mapping deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

