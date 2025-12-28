import { prisma } from '../lib/prisma';

// Import node-zklib - it's a constructor function
const ZKLibConstructor = require('node-zklib');

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
  private device: any | null = null; // ZKLib instance
  private zkInstance: any | null = null; // ZKLib constructor instance
  private config: ZKTDeviceConfig;

  constructor(config: ZKTDeviceConfig) {
    this.config = {
      ...config,
      timeout: config.timeout || 10000, // Increased timeout to 10 seconds
      inport: config.inport || 0,
    };
  }

  /**
   * Connect to the ZKTeco device
   */
  async connect(): Promise<boolean> {
    try {
      console.log(`Attempting to connect to ZKTeco device at ${this.config.ip}:${this.config.port}...`);
      
      // Create ZKLib instance with constructor parameters: (ip, port, timeout, inport)
      if (!this.zkInstance) {
        this.zkInstance = new ZKLibConstructor(
          this.config.ip,
          this.config.port,
          this.config.timeout,
          this.config.inport
        );
      }
      
      // createSocket takes optional callbacks (cbErr, cbClose) - we can pass undefined
      await this.zkInstance.createSocket(undefined, undefined);
      this.device = this.zkInstance; // Store the instance as device
      console.log(`Successfully connected to device at ${this.config.ip}:${this.config.port}`);
      return true;
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      const errorCode = error?.code || 'NO_CODE';
      const errorDetails = error?.stack || error?.toString() || '';
      
      console.error(`Failed to connect to ZKTeco device at ${this.config.ip}:${this.config.port}`);
      console.error(`Error: ${errorMessage}`);
      console.error(`Error Code: ${errorCode}`);
      
      if (process.env.NODE_ENV === 'development') {
        console.error('Full error details:', errorDetails);
      }
      
      // Common error patterns
      if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        console.error('Connection timeout - device may be slow to respond or protocol mismatch');
      } else if (errorMessage.includes('ECONNREFUSED')) {
        console.error('Connection refused - device may not be accepting connections on this port');
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('EHOSTUNREACH')) {
        console.error('Host unreachable - check IP address and network connectivity');
      }
      
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
        this.zkInstance = null;
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
      const result = await this.device.getAttendances();
      
      // The library returns { data: [...], err: ... } structure
      if (!result) {
        return [];
      }
      
      // Check if result has a data property (library format)
      if (result && typeof result === 'object' && 'data' in result) {
        const logs = result.data;
        if (Array.isArray(logs)) {
          return logs;
        }
        return [];
      }
      
      // If it's already an array, return it
      if (Array.isArray(result)) {
        return result;
      }
      
      return [];
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
      const result = await this.device.getUsers();
      
      // The library returns { data: [...], err: ... } structure
      if (!result) {
        console.warn('getUsers() returned null/undefined, returning empty array');
        return [];
      }
      
      // Check if result has a data property (library format)
      if (result && typeof result === 'object' && 'data' in result) {
        const users = result.data;
        if (Array.isArray(users)) {
          return users;
        }
        console.warn('getUsers().data is not an array:', typeof users, users);
        return [];
      }
      
      // If it's already an array, return it
      if (Array.isArray(result)) {
        return result;
      }
      
      // If it's an object with a users property, use that
      if (result && typeof result === 'object' && 'users' in result && Array.isArray(result.users)) {
        return result.users;
      }
      
      // Log what we got for debugging
      console.warn('getUsers() returned unexpected format:', typeof result, result);
      
      // Last resort: return empty array
      return [];
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
        // Get device user ID - use id if available, otherwise fallback to uid
        const deviceUserId = (log.id !== undefined && log.id !== null) 
          ? log.id.toString() 
          : (log.uid !== undefined && log.uid !== null)
            ? log.uid.toString()
            : null;

        if (!deviceUserId) {
          console.warn(`Log entry missing both id and uid fields:`, JSON.stringify(log));
          errors++;
          continue;
        }

        if (!log.timestamp) {
          console.warn(`Log entry missing timestamp:`, JSON.stringify(log));
          errors++;
          continue;
        }

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

    // Auto-checkout members who checked in on previous dates but didn't check out
    await autoCheckoutIncompleteRecords(gymId);
  } catch (error) {
    console.error('Error syncing attendance:', error);
    throw error;
  } finally {
    await zktService.disconnect();
  }

  return { synced, errors };
}

/**
 * Auto-checkout members who checked in on previous dates but didn't check out
 * Sets checkout time to 1 hour after check-in time
 */
export async function autoCheckoutIncompleteRecords(gymId: string): Promise<number> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find all records where:
    // - checkInTime exists
    // - checkOutTime is null
    // - date is not today (previous dates)
    const incompleteRecords = await prisma.attendanceRecord.findMany({
      where: {
        gymId,
        checkInTime: { not: null },
        checkOutTime: null,
        date: { lt: today },
      },
    });

    let autoCheckedOut = 0;

    for (const record of incompleteRecords) {
      if (record.checkInTime) {
        // Set checkout time to 1 hour after check-in time
        const checkOutTime = new Date(record.checkInTime);
        checkOutTime.setHours(checkOutTime.getHours() + 1);

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: { checkOutTime },
        });

        console.log(
          `Auto-checked out member ${record.memberId} for date ${record.date.toISOString().split('T')[0]}. ` +
          `Check-in: ${record.checkInTime.toISOString()}, Check-out: ${checkOutTime.toISOString()}`
        );
        autoCheckedOut++;
      }
    }

    if (autoCheckedOut > 0) {
      console.log(`Auto-checked out ${autoCheckedOut} incomplete attendance records from previous dates`);
    }

    return autoCheckedOut;
  } catch (error) {
    console.error('Error auto-checking out incomplete records:', error);
    return 0;
  }
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
      throw new Error(
        `Failed to connect to device at ${deviceConfig.ipAddress}:${deviceConfig.port}. ` +
        `Please check: 1) Device is powered on, 2) IP address is correct, 3) Network connectivity, 4) Port 4370 is accessible, 5) Firewall settings`
      );
    }

    const deviceUsers = await zktService.getUsers();

    // Ensure deviceUsers is an array
    if (!Array.isArray(deviceUsers)) {
      console.error('getUsers() did not return an array:', typeof deviceUsers, deviceUsers);
      throw new Error(`Failed to fetch users from device. Expected array but got ${typeof deviceUsers}`);
    }

    console.log(`Found ${deviceUsers.length} users on device`);

    // Map device users to members by member ID (userId field from device)
    let mapped = 0;
    for (const deviceUser of deviceUsers) {
      // Use userId from device as member ID
      const memberId = parseInt(deviceUser.userId, 10);
      
      if (isNaN(memberId)) {
        console.log(`Skipping device user "${deviceUser.name}" (uid: ${deviceUser.uid}): userId "${deviceUser.userId}" is not a valid number`);
        continue;
      }

      // Check if member exists in the database for this gym
      const member = await prisma.member.findFirst({
        where: {
          id: memberId,
          gymId,
        },
        select: { id: true },
      });

      if (member) {
        // Create or update mapping using device userId (uid) and member ID
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
            deviceUserName: null, // Don't save device name
            isActive: true,
          },
          update: {
            isActive: true,
            // Don't update deviceUserName - keep it null
          },
        });
        console.log(`Mapped device user (uid: ${deviceUser.uid}, userId: ${deviceUser.userId}) to member ID: ${member.id}`);
        mapped++;
      } else {
        console.log(`No member found with ID ${memberId} for gym ${gymId} (device user uid: ${deviceUser.uid}, userId: ${deviceUser.userId})`);
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

