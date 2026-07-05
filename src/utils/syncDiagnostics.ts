import { Request } from 'express';

export type SyncAuthMode = 'API_KEY';

export interface SyncDiagnostic {
  title: string;
  cause: string;
  mode: SyncAuthMode;
  deviceConfigId: number;
  gymId?: number;
  url?: string;
  httpStatus?: number;
  message: string;
  checks: string[];
  /** Multi-line text for tablet/dashboard status cards */
  diagnosticText: string;
  device?: {
    name?: string;
    ipAddress?: string;
    port?: number;
    isActive?: boolean;
    lastSyncAt?: string | null;
  };
  auth?: {
    keySource?: 'gym_sync_api_key' | 'env_offline_sync_api_key' | 'none';
    gymHasSyncKey?: boolean;
    envKeyConfigured?: boolean;
  };
}

export function buildOfflineSyncUrl(req: Request, deviceConfigId: number, path: string): string {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || 'api.example.com';
  return `${proto}://${host}/api/device/${deviceConfigId}${path}`;
}

function formatSection(title: string, lines: string[]): string {
  const divider = '─'.repeat(Math.min(title.length, 40));
  return [title, divider, ...lines].join('\n');
}

export function formatSyncDiagnosticText(d: Omit<SyncDiagnostic, 'diagnosticText'>): string {
  const lines: string[] = [
    `Mode: ${d.mode}`,
  ];
  if (d.url) lines.push(`URL: ${d.url}`);
  lines.push(`Device Config ID: ${d.deviceConfigId}`);
  if (d.gymId !== undefined) lines.push(`Gym ID: ${d.gymId}`);
  if (d.httpStatus !== undefined) lines.push(`HTTP status: ${d.httpStatus}`);
  lines.push(`Cause: ${d.cause}`);
  lines.push(`Message: ${d.message}`);
  if (d.device) {
    if (d.device.name) lines.push(`Device name: ${d.device.name}`);
    if (d.device.ipAddress) {
      lines.push(`Device IP: ${d.device.ipAddress}:${d.device.port ?? 4370}`);
    }
    if (d.device.isActive === false) lines.push('Device status: INACTIVE in admin');
    if (d.device.lastSyncAt) lines.push(`Last sync: ${d.device.lastSyncAt}`);
  }
  if (d.auth) {
    if (d.auth.keySource) lines.push(`API key source expected: ${d.auth.keySource}`);
    if (d.auth.gymHasSyncKey !== undefined) {
      lines.push(`Gym sync key configured: ${d.auth.gymHasSyncKey ? 'yes' : 'no'}`);
    }
    if (d.auth.envKeyConfigured !== undefined) {
      lines.push(`Server OFFLINE_SYNC_API_KEY set: ${d.auth.envKeyConfigured ? 'yes' : 'no'}`);
    }
  }
  lines.push('Checks:');
  for (const check of d.checks) {
    lines.push(`• ${check}`);
  }
  return formatSection(d.title, lines);
}

export function buildSyncDiagnostic(
  input: Omit<SyncDiagnostic, 'diagnosticText'>
): SyncDiagnostic {
  return {
    ...input,
    diagnosticText: formatSyncDiagnosticText(input),
  };
}

export function diagnosticDetails(d: SyncDiagnostic): { diagnostic: SyncDiagnostic } {
  return { diagnostic: d };
}

/** Common troubleshooting hints for tablet → backend offline sync */
export const BACKEND_SYNC_CHECKS = {
  apiKey: [
    'Copy the API key from FitNix admin → Devices → Tablet sync setup',
    'Use the per-gym syncApiKey (not your login password)',
    'Send apiKey in the JSON body or X-Api-Key header',
    'If the key was regenerated, update the tablet settings',
  ],
  deviceId: [
    'Device Config ID must match a device row in FitNix admin for your gym',
    'Open Tablet sync setup in the dashboard and use the listed device id',
    'Do not use the fingerprint machine serial number as the config id',
  ],
  network: [
    'Tablet has internet access (Wi‑Fi or mobile data)',
    'Backend base URL is correct (no trailing slash issues)',
    'Server is reachable (not blocked by firewall or wrong environment URL)',
  ],
  gym: [
    'Gym account is active (not suspended by platform admin)',
    'Sync was enabled and a sync key was generated for this gym',
  ],
};

export function buildBackendTestSuccessDiagnostic(input: {
  req: Request;
  deviceConfigId: number;
  gymId: number;
  device: {
    name: string;
    ipAddress: string;
    port: number;
    isActive: boolean;
    lastSyncAt: Date | null;
    serialNumber?: string | null;
  };
  keySource: 'gym_sync_api_key' | 'env_offline_sync_api_key';
}): SyncDiagnostic {
  const url = buildOfflineSyncUrl(input.req, input.deviceConfigId, '/test-backend-offline');
  return buildSyncDiagnostic({
    title: 'BACKEND TEST OK',
    cause: 'connected',
    mode: 'API_KEY',
    deviceConfigId: input.deviceConfigId,
    gymId: input.gymId,
    url,
    httpStatus: 200,
    message: 'Backend reachable, API key valid, device configuration found.',
    checks: [
      'Backend authentication succeeded',
      'Device configuration exists for this gym',
      'You can run user and attendance offline sync from the tablet',
    ],
    device: {
      name: input.device.name,
      ipAddress: input.device.ipAddress,
      port: input.device.port,
      isActive: input.device.isActive,
      lastSyncAt: input.device.lastSyncAt?.toISOString() ?? null,
    },
    auth: {
      keySource: input.keySource,
      gymHasSyncKey: input.keySource === 'gym_sync_api_key',
      envKeyConfigured: Boolean(process.env.OFFLINE_SYNC_API_KEY),
    },
  });
}
