import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
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
      const { startDate, endDate } = req.query as any;

      const device = await prisma.deviceConfig.findFirst({
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
      });

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
        // If lastSyncAt exists, only fetch logs after that time
        // Otherwise, use provided startDate or fetch all
        let syncStartTime: Date | undefined;
        if (device.lastSyncAt) {
          syncStartTime = device.lastSyncAt;
          console.log(`Incremental sync: fetching logs after ${syncStartTime.toISOString()}`);
        } else if (startDate) {
          syncStartTime = parseDate(startDate);
        }

        // Parse end date if provided
        const syncEndTime = endDate ? parseDate(endDate) : undefined;

        // Filter logs: only process new logs since last sync
        let newLogs = logs.filter((log) => {
          const logDate = new Date(log.timestamp * 1000);
          
          // If we have a sync start time, only include logs after it
          if (syncStartTime && logDate <= syncStartTime) {
            return false;
          }
          
          // Filter by date range if provided
          if (syncEndTime && logDate > syncEndTime) {
            return false;
          }
          
          return true;
        });

        console.log(`Found ${logs.length} total logs, ${newLogs.length} new logs since last sync`);

        let synced = 0;
        let errors = 0;
        const formattedLogs: any[] = [];

        // Process each new log entry and save to database
        for (const log of newLogs) {
          try {
            const deviceUserId = log.id.toString();
            const memberId = deviceUserToMemberMap.get(deviceUserId);
            const memberInfo = deviceUserToMemberInfoMap.get(deviceUserId);

            if (!memberId) {
              console.warn(`No member mapping found for device user ID: ${deviceUserId}`);
              errors++;
              continue;
            }

            const logDate = new Date(log.timestamp * 1000);
            const dateOnly = new Date(logDate.getFullYear(), logDate.getMonth(), logDate.getDate());

            // Determine if this is check-in or check-out
            const isCheckIn = log.type === 0 || (log.type === undefined && log.state === 0);
            const eventType = isCheckIn ? 'CHECK_IN' : 'CHECK_OUT';

            // Find or create attendance record for this date
            const existingRecord = await prisma.attendanceRecord.findUnique({
              where: {
                gymId_memberId_date: {
                  gymId,
                  memberId,
                  date: dateOnly,
                },
              },
            });

            let wasUpdated = false;

            if (existingRecord) {
              // Update existing record
              let updateData: any = {
                deviceUserId,
                deviceSerialNumber: device.serialNumber || undefined,
                status: 'PRESENT',
              };

              if (isCheckIn) {
                // This is a check-in - update if we don't have one or this is earlier
                if (!existingRecord.checkInTime || logDate < existingRecord.checkInTime) {
                  updateData.checkInTime = logDate;
                  wasUpdated = true;
                }
              } else {
                // This is a check-out - update if we don't have one or this is later
                if (!existingRecord.checkOutTime || logDate > existingRecord.checkOutTime) {
                  updateData.checkOutTime = logDate;
                  wasUpdated = true;
                }
              }

              // If we can't determine from type/state, use timing logic
              if (log.type === undefined && log.state === undefined) {
                if (!existingRecord.checkInTime) {
                  updateData.checkInTime = logDate;
                  wasUpdated = true;
                } else if (!existingRecord.checkOutTime && logDate > existingRecord.checkInTime) {
                  updateData.checkOutTime = logDate;
                  wasUpdated = true;
                } else if (logDate < existingRecord.checkInTime) {
                  updateData.checkInTime = logDate;
                  wasUpdated = true;
                }
              }

              // Only update if we have changes
              if (wasUpdated) {
                await prisma.attendanceRecord.update({
                  where: { id: existingRecord.id },
                  data: updateData,
                });
                synced++;
              }
            } else {
              // Create new record
              await prisma.attendanceRecord.create({
                data: {
                  gymId,
                  memberId,
                  date: dateOnly,
                  status: 'PRESENT',
                  checkInTime: isCheckIn ? logDate : undefined,
                  checkOutTime: !isCheckIn ? logDate : undefined,
                  deviceUserId,
                  deviceSerialNumber: device.serialNumber || undefined,
                },
              });
              synced++;
              wasUpdated = true;
            }

            // Add to formatted logs for response
            if (wasUpdated || !existingRecord) {
              formattedLogs.push({
                uid: log.uid,
                deviceUserId: deviceUserId,
                eventType: eventType,
                timestamp: log.timestamp,
                dateTime: logDate.toISOString(),
                date: logDate.toISOString().split('T')[0],
                time: logDate.toTimeString().split(' ')[0],
                type: log.type,
                state: log.state,
                member: memberInfo || null,
              });
            }
          } catch (error) {
            console.error(`Error processing log entry:`, error);
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
          logs: formattedLogs.sort((a, b) => b.timestamp - a.timestamp),
          summary: {
            totalRecords: formattedLogs.length,
            checkInsCount: checkIns.length,
            checkOutsCount: checkOuts.length,
            syncedCount: synced,
            errorCount: errors,
            lastSyncAt: newLastSyncAt.toISOString(),
            previousSyncAt: device.lastSyncAt ? device.lastSyncAt.toISOString() : null,
            dateRange: {
              start: syncStartTime ? syncStartTime.toISOString().split('T')[0] : null,
              end: syncEndTime ? syncEndTime.toISOString().split('T')[0] : null,
            },
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

