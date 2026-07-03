/** Portal + tablet shape for attendance device config rows. */
export interface PortalDeviceDto {
  id: number;
  name: string;
  ipAddress: string;
  deviceConfigId: string;
  lastSyncAt: string | null;
  isActive: boolean;
  port?: number;
}

export function formatDeviceForPortal(device: {
  id: number;
  name: string;
  ipAddress: string;
  lastSyncAt: Date | null;
  isActive: boolean;
  port?: number;
}): PortalDeviceDto {
  return {
    id: device.id,
    name: device.name,
    ipAddress: device.ipAddress,
    deviceConfigId: String(device.id),
    lastSyncAt: device.lastSyncAt ? device.lastSyncAt.toISOString() : null,
    isActive: device.isActive,
    ...(device.port !== undefined ? { port: device.port } : {}),
  };
}

export interface SyncResultDto {
  syncedRecords: number;
  autoCheckedOut: number;
  markedInactive: number;
}

export function formatSyncResultDto(input: {
  syncedRecords: number;
  autoCheckedOut?: number;
  markedInactive?: number;
}): SyncResultDto {
  return {
    syncedRecords: input.syncedRecords,
    autoCheckedOut: input.autoCheckedOut ?? 0,
    markedInactive: input.markedInactive ?? 0,
  };
}
