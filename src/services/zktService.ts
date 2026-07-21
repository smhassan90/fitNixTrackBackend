import { prisma } from '../lib/prisma';
import { getGymTimezone, parseDevicePunchInstant } from '../utils/dateHelpers';
import { applyAttendancePolicies } from './attendancePolicyService';
import {
  applyPunchToAttendance,
  buildDeviceUserIdentifierMap,
  resolveCanonicalDeviceUserId,
  storePendingAttendanceLog,
  upsertDeviceUsers,
} from './deviceMappingService';

// Import node-zklib - it's a constructor function
import ZKLibConstructor from 'node-zklib';

export interface ZKTDeviceConfig {
  ip: string;
  port: number;
  timeout?: number;
  inport?: number;
}

export interface AttendanceLog {
  uid?: number;
  id?: number;
  state?: number;
  timestamp?: number;
  type?: number;
  // New format fields
  userSn?: number;
  deviceUserId?: string;
  recordTime?: string; // ISO date string
  ip?: string;
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
        this.zkInstance = new (ZKLibConstructor as any)(
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
   * Retries on timeout errors
   */
  async getAttendanceLogs(retries: number = 3): Promise<AttendanceLog[]> {
    if (!this.device) {
      throw new Error('Device not connected. Call connect() first.');
    }

    let lastError: any = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`Fetching attendance logs (attempt ${attempt}/${retries})...`);
        
        // Set a longer timeout for getAttendances if device has many logs
        const result = await Promise.race([
          this.device.getAttendances(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout after 30 seconds')), 30000)
          )
        ]) as any;
        
        // The library returns { data: [...], err: ... } structure
        if (!result) {
          return [];
        }
        
        // Check if result has an error
        if (result.err) {
          const error = result.err;
          // Check if it's a timeout error
          if (error.message && error.message.includes('TIMEOUT')) {
            console.warn(`Timeout error on attempt ${attempt}. ${attempt < retries ? 'Retrying...' : 'Max retries reached.'}`);
            lastError = error;
            if (attempt < retries) {
              // Wait before retrying (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
              continue;
            }
          }
          throw error;
        }
        
        // Check if result has a data property (library format)
        if (result && typeof result === 'object' && 'data' in result) {
          const logs = result.data;
          if (Array.isArray(logs)) {
            console.log(`Successfully fetched ${logs.length} attendance logs`);
            return logs;
          }
          return [];
        }
        
        // If it's already an array, return it
        if (Array.isArray(result)) {
          console.log(`Successfully fetched ${result.length} attendance logs`);
          return result;
        }
        
        return [];
      } catch (error: any) {
        lastError = error;
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        
        // Check if it's a timeout error
        if (errorMessage.includes('TIMEOUT') || errorMessage.includes('timeout')) {
          console.warn(`Timeout error on attempt ${attempt}/${retries}: ${errorMessage}`);
          if (attempt < retries) {
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            continue;
          }
        }
        
        // If it's the last attempt or not a timeout, throw the error
        if (attempt === retries) {
          console.error(`Error fetching attendance logs after ${retries} attempts:`, error);
          throw new Error(`Failed to fetch attendance logs: ${errorMessage}. Device may have too many logs or network issues.`);
        }
      }
    }
    
    // Should not reach here, but just in case
    throw lastError || new Error('Failed to fetch attendance logs after retries');
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
  deviceConfigId: number,
  gymId: number,
  startDate?: Date,
  endDate?: Date
): Promise<{
  synced: number;
  pending: number;
  errors: number;
  autoCheckedOut: number;
  markedInactive: number;
}> {
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
  let pending = 0;
  let errors = 0;
  let autoCheckedOut = 0;
  let markedInactive = 0;

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
        const logDate = parseDevicePunchInstant(
          log.recordTime ?? log.timestamp,
          getGymTimezone()
        );
        if (!logDate) return false;
        if (startDate && logDate < startDate) return false;
        if (endDate && logDate > endDate) return false;
        return true;
      });
    }

    // Create a map of device user ID to member ID
    const deviceUserToMemberMap = new Map<string, number>();
    (deviceConfig.userMappings || []).forEach((mapping: any) => {
      deviceUserToMemberMap.set(mapping.deviceUserId, mapping.memberId);
    });

    const deviceUserIdMap = await buildDeviceUserIdentifierMap(deviceConfigId);

    // Process each log entry
    for (const log of filteredLogs) {
      try {
        // Get device user ID - handle different log formats
        let deviceUserId: string | null = null;
        
        if (log.deviceUserId !== undefined && log.deviceUserId !== null) {
          // New format: deviceUserId is already a string
          deviceUserId = log.deviceUserId.toString();
        } else if (log.id !== undefined && log.id !== null) {
          deviceUserId = log.id.toString();
        } else if (log.uid !== undefined && log.uid !== null) {
          deviceUserId = log.uid.toString();
        } else if (log.userSn !== undefined && log.userSn !== null) {
          deviceUserId = log.userSn.toString();
        }

        if (!deviceUserId) {
          console.warn(`Log entry missing device user ID:`, JSON.stringify(log));
          errors++;
          continue;
        }

        deviceUserId = resolveCanonicalDeviceUserId(deviceUserIdMap, deviceUserId);

        // Handle timestamp - support both formats; naive device clock → gym TZ
        const logDate = parseDevicePunchInstant(
          log.recordTime ?? log.timestamp,
          getGymTimezone()
        );
        if (!logDate) {
          console.warn(`Log entry missing/invalid timestamp/recordTime:`, JSON.stringify(log));
          errors++;
          continue;
        }

        const memberId = deviceUserToMemberMap.get(deviceUserId);

        if (!memberId) {
          // Keep punches for later — mapping window will apply them
          const stored = await storePendingAttendanceLog({
            gymId,
            deviceConfigId,
            deviceUserId,
            recordTime: logDate,
            type: log.type,
            state: log.state,
            deviceSerialNumber: deviceConfig.serialNumber,
          });
          if (stored) pending++;
          else errors++;
          continue;
        }

        const wrote = await applyPunchToAttendance({
          gymId,
          memberId,
          deviceUserId,
          logDate,
          type: log.type,
          state: log.state,
          deviceSerialNumber: deviceConfig.serialNumber,
        });
        if (wrote) synced++;
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

    // Auto-checkout open sessions and apply absence-based inactive rules
    const policies = await applyAttendancePolicies(gymId);
    autoCheckedOut = policies.autoCheckedOut;
    markedInactive = policies.markedInactive;
  } catch (error) {
    console.error('Error syncing attendance:', error);
    throw error;
  } finally {
    await zktService.disconnect();
  }

  return {
    synced,
    pending,
    errors,
    autoCheckedOut,
    markedInactive,
  };
}

/**
 * @deprecated Prefer applyAttendancePolicies. Kept for existing imports.
 */
export async function autoCheckoutIncompleteRecords(gymId: number): Promise<number> {
  const result = await applyAttendancePolicies(gymId);
  return result.autoCheckedOut;
}

/**
 * Sync users from device into device_users.
 * Does not auto-create member mappings — use the mapping window to confirm.
 */
export async function syncUsersFromDevice(
  deviceConfigId: number,
  gymId: number
): Promise<{ users: DeviceUser[]; stored: number }> {
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

    const stored = await upsertDeviceUsers(
      deviceConfigId,
      deviceUsers.map((deviceUser) => ({
        deviceUserId: deviceUser.uid.toString(),
        deviceUserName: deviceUser.name || null,
        deviceBadgeId: deviceUser.userId?.toString() || null,
      }))
    );

    return { users: deviceUsers, stored };
  } catch (error) {
    console.error('Error syncing users:', error);
    throw error;
  } finally {
    await zktService.disconnect();
  }
}

