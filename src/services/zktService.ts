import ZKLib from 'node-zklib';
import { prisma } from '../lib/prisma';

export interface ZKTDeviceConfig {
  ip: string;
  port: number;
  timeout?: number;
  inport?: number;
}

export interface AttendanceLog {
  uid: number;
  id: number;
  state: number;
  timestamp: number;
  type: number;
}

export interface DeviceUser {
  uid: number;
  name: string;
  privilege: number;
  password: string;
  groupId: string;
  userId: string;
  card: number;
}

export class ZKTService {
  private device: ZKLib | null = null;
  private config: ZKTDeviceConfig;

  constructor(config: ZKTDeviceConfig) {
    this.config = {
      ...config,
      timeout: config.timeout || 5000,
      inport: config.inport || 0,
    };
  }

  /**
   * Connect to the ZKTeco device
   */
  async connect(): Promise<boolean> {
    try {
      this.device = await ZKLib.createSocket(this.config);
      return true;
    } catch (error) {
      console.error('Failed to connect to ZKTeco device:', error);
      return false;
    }
  }

  /**
   * Disconnect from the device
   */
  async disconnect(): Promise<void> {
    if (this.device) {
      try {
        await this.device.disconnect();
      } catch (error) {
        console.error('Error disconnecting from device:', error);
      } finally {
        this.device = null;
      }
    }
  }

  /**
   * Get all attendance logs from the device
   */
  async getAttendanceLogs(): Promise<AttendanceLog[]> {
    if (!this.device) {
      throw new Error('Device not connected. Call connect() first.');
    }

    try {
      const logs = await this.device.getAttendances();
      return logs || [];
    } catch (error) {
      console.error('Error fetching attendance logs:', error);
      throw error;
    }
  }

  /**
   * Get all users from the device
   */
  async getUsers(): Promise<DeviceUser[]> {
    if (!this.device) {
      throw new Error('Device not connected. Call connect() first.');
    }

    try {
      const users = await this.device.getUsers();
      return users || [];
    } catch (error) {
      console.error('Error fetching users:', error);
      throw error;
    }
  }

  /**
   * Get device serial number
   */
  async getSerialNumber(): Promise<string | null> {
    if (!this.device) {
      throw new Error('Device not connected. Call connect() first.');
    }

    try {
      const serial = await this.device.getSerialNumber();
      return serial || null;
    } catch (error) {
      console.error('Error fetching serial number:', error);
      return null;
    }
  }

  /**
   * Get device time
   */
  async getDeviceTime(): Promise<Date | null> {
    if (!this.device) {
      throw new Error('Device not connected. Call connect() first.');
    }

    try {
      const time = await this.device.getTime();
      return time || null;
    } catch (error) {
      console.error('Error fetching device time:', error);
      return null;
    }
  }

  /**
   * Set device time
   */
  async setDeviceTime(date: Date): Promise<boolean> {
    if (!this.device) {
      throw new Error('Device not connected. Call connect() first.');
    }

    try {
      await this.device.setTime(date);
      return true;
    } catch (error) {
      console.error('Error setting device time:', error);
      return false;
    }
  }

  /**
   * Clear all attendance logs from device
   */
  async clearAttendanceLogs(): Promise<boolean> {
    if (!this.device) {
      throw new Error('Device not connected. Call connect() first.');
    }

    try {
      await this.device.clearAttendanceLog();
      return true;
    } catch (error) {
      console.error('Error clearing attendance logs:', error);
      return false;
    }
  }

  /**
   * Test device connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const connected = await this.connect();
      if (connected) {
        await this.disconnect();
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }
}

/**
 * Sync attendance from ZKTeco device to database
 */
export async function syncAttendanceFromDevice(
  deviceConfigId: string,
  gymId: string,
  startDate?: Date,
  endDate?: Date
): Promise<{ synced: number; errors: number }> {
  const deviceConfig = await prisma.deviceConfig.findUnique({
    where: { id: deviceConfigId },
    include: {
      userMappings: {
        where: { isActive: true },
      },
    },
  });

  if (!deviceConfig) {
    throw new Error('Device configuration not found');
  }

  if (deviceConfig.gymId !== gymId) {
    throw new Error('Device does not belong to this gym');
  }

  const zktService = new ZKTService({
    ip: deviceConfig.ipAddress,
    port: deviceConfig.port,
  });

  let synced = 0;
  let errors = 0;

  try {
    const connected = await zktService.connect();
    if (!connected) {
      throw new Error('Failed to connect to device');
    }

    // Get attendance logs from device
    const logs = await zktService.getAttendanceLogs();

    // Filter logs by date range if provided
    let filteredLogs = logs;
    if (startDate || endDate) {
      filteredLogs = logs.filter((log) => {
        const logDate = new Date(log.timestamp * 1000);
        if (startDate && logDate < startDate) return false;
        if (endDate && logDate > endDate) return false;
        return true;
      });
    }

    // Create a map of device user ID to member ID
    const deviceUserToMemberMap = new Map<string, number>();
    deviceConfig.userMappings.forEach((mapping) => {
      deviceUserToMemberMap.set(mapping.deviceUserId, mapping.memberId);
    });

    // Process each log entry
    for (const log of filteredLogs) {
      try {
        const deviceUserId = log.id.toString();
        const memberId = deviceUserToMemberMap.get(deviceUserId);

        if (!memberId) {
          console.warn(`No member mapping found for device user ID: ${deviceUserId}`);
          errors++;
          continue;
        }

        const logDate = new Date(log.timestamp * 1000);
        const dateOnly = new Date(logDate.getFullYear(), logDate.getMonth(), logDate.getDate());

        // Determine if this is check-in or check-out
        // For ZKTeco devices: type 0 = Check-in, type 1 = Check-out
        // State can also indicate: 0 = Check-in, 1 = Check-out
        // We prioritize type field, fallback to state
        const isCheckIn = log.type === 0 || (log.type === undefined && log.state === 0);

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

        if (existingRecord) {
          // Update existing record
          // If we have check-in time but not check-out, and this is later, treat as check-out
          // If we have check-out but this is earlier check-in, update check-in
          // Otherwise, use type/state to determine
          let updateData: any = {
            deviceUserId,
            deviceSerialNumber: deviceConfig.serialNumber || undefined,
            status: 'PRESENT',
          };

          if (isCheckIn) {
            // This is a check-in - update if we don't have one or this is earlier
            if (!existingRecord.checkInTime || logDate < existingRecord.checkInTime) {
              updateData.checkInTime = logDate;
            }
          } else {
            // This is a check-out - update if we don't have one or this is later
            if (!existingRecord.checkOutTime || logDate > existingRecord.checkOutTime) {
              updateData.checkOutTime = logDate;
            }
          }

          // If we can't determine from type/state, use timing logic
          if (log.type === undefined && log.state === undefined) {
            if (!existingRecord.checkInTime) {
              updateData.checkInTime = logDate;
            } else if (!existingRecord.checkOutTime && logDate > existingRecord.checkInTime) {
              updateData.checkOutTime = logDate;
            } else if (logDate < existingRecord.checkInTime) {
              // Earlier entry, treat as check-in
              updateData.checkInTime = logDate;
            }
          }

          // Only update if we have changes
          if (updateData.checkInTime || updateData.checkOutTime) {
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
              deviceSerialNumber: deviceConfig.serialNumber || undefined,
            },
          });
          synced++;
        }
      } catch (error) {
        console.error(`Error processing log entry:`, error);
        errors++;
      }
    }

    // Update last sync time
    await prisma.deviceConfig.update({
      where: { id: deviceConfigId },
      data: { lastSyncAt: new Date() },
    });
  } catch (error) {
    console.error('Error syncing attendance:', error);
    throw error;
  } finally {
    await zktService.disconnect();
  }

  return { synced, errors };
}

/**
 * Sync users from device and create mappings
 */
export async function syncUsersFromDevice(
  deviceConfigId: string,
  gymId: string
): Promise<{ users: DeviceUser[]; mapped: number }> {
  const deviceConfig = await prisma.deviceConfig.findUnique({
    where: { id: deviceConfigId },
  });

  if (!deviceConfig) {
    throw new Error('Device configuration not found');
  }

  if (deviceConfig.gymId !== gymId) {
    throw new Error('Device does not belong to this gym');
  }

  const zktService = new ZKTService({
    ip: deviceConfig.ipAddress,
    port: deviceConfig.port,
  });

  try {
    const connected = await zktService.connect();
    if (!connected) {
      throw new Error('Failed to connect to device');
    }

    const deviceUsers = await zktService.getUsers();

    // Get all members for this gym
    const members = await prisma.member.findMany({
      where: { gymId },
      select: { id: true, name: true },
    });

    // Try to match device users with members by name
    let mapped = 0;
    for (const deviceUser of deviceUsers) {
      const member = members.find(
        (m) => m.name.toLowerCase().trim() === deviceUser.name.toLowerCase().trim()
      );

      if (member) {
        // Create or update mapping
        await prisma.deviceUserMapping.upsert({
          where: {
            deviceConfigId_deviceUserId: {
              deviceConfigId,
              deviceUserId: deviceUser.uid.toString(),
            },
          },
          create: {
            deviceConfigId,
            memberId: member.id,
            deviceUserId: deviceUser.uid.toString(),
            deviceUserName: deviceUser.name,
            isActive: true,
          },
          update: {
            deviceUserName: deviceUser.name,
            isActive: true,
          },
        });
        mapped++;
      }
    }

    return { users: deviceUsers, mapped };
  } catch (error) {
    console.error('Error syncing users:', error);
    throw error;
  } finally {
    await zktService.disconnect();
  }
}

