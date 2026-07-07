import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { sendError } from '../utils/response';
import {
  BACKEND_SYNC_CHECKS,
  buildOfflineSyncUrl,
  buildSyncDiagnostic,
  diagnosticDetails,
} from '../utils/syncDiagnostics';

export interface ApiKeyAuthRequest extends Request {
  deviceId?: number;
  gymId?: number;
  syncKeySource?: 'gym_sync_api_key' | 'env_offline_sync_api_key';
}

/**
 * Inside the device router, req.path already includes the leading `/:id`
 * (e.g. `/1/sync-attendance-offline`). buildOfflineSyncUrl re-adds
 * `/api/device/{id}`, so pass the sub-path without the id to avoid a
 * doubled segment like `/api/device/1/1/sync-attendance-offline`.
 */
function stripDeviceIdPrefix(path: string): string {
  return path.replace(/^\/\d+/, '') || '/';
}

function backendFail(
  req: Request,
  deviceConfigId: number,
  httpStatus: number,
  cause: string,
  message: string,
  checks: string[],
  extra?: {
    gymId?: number;
    auth?: SyncDiagnosticAuth;
  }
): UnauthorizedError | ForbiddenError {
  const diagnostic = buildSyncDiagnostic({
    title: 'BACKEND TEST FAILED',
    cause,
    mode: 'API_KEY',
    deviceConfigId,
    gymId: extra?.gymId,
    url: buildOfflineSyncUrl(req, deviceConfigId, stripDeviceIdPrefix(req.path)),
    httpStatus,
    message,
    checks,
    auth: extra?.auth,
  });

  if (httpStatus === 403) {
    return new ForbiddenError(message, diagnosticDetails(diagnostic));
  }
  return new UnauthorizedError(message, diagnosticDetails(diagnostic));
}

type SyncDiagnosticAuth = {
  keySource?: 'gym_sync_api_key' | 'env_offline_sync_api_key' | 'none';
  gymHasSyncKey?: boolean;
  envKeyConfigured?: boolean;
};

/**
 * Middleware to authenticate requests using API key
 * Validates API key against device configuration
 */
export async function authenticateApiKey(
  req: ApiKeyAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const apiKey = req.body?.apiKey || (req.headers['x-api-key'] as string);
    const deviceIdParam = parseInt(req.params.id, 10);

    if (isNaN(deviceIdParam)) {
      const diagnostic = buildSyncDiagnostic({
        title: 'BACKEND TEST FAILED',
        cause: 'invalid_device_id',
        mode: 'API_KEY',
        deviceConfigId: -1,
        url: req.originalUrl,
        httpStatus: 401,
        message: 'Invalid device ID in URL — must be a numeric Device Config ID',
        checks: [
          ...BACKEND_SYNC_CHECKS.deviceId,
          'URL path should be /api/device/{id}/... where {id} is digits only',
        ],
      });
      sendError(res, new UnauthorizedError(diagnostic.message, diagnosticDetails(diagnostic)));
      return;
    }

    if (!apiKey) {
      sendError(
        res,
        backendFail(
          req,
          deviceIdParam,
          401,
          'missing_api_key',
          'API key is required',
          [
            ...BACKEND_SYNC_CHECKS.apiKey,
            ...BACKEND_SYNC_CHECKS.network,
          ],
          {
            auth: {
              keySource: 'none',
              envKeyConfigured: Boolean(process.env.OFFLINE_SYNC_API_KEY),
            },
          }
        )
      );
      return;
    }

    const device = await prisma.deviceConfig.findUnique({
      where: { id: deviceIdParam },
      select: {
        id: true,
        gymId: true,
        name: true,
        ipAddress: true,
        port: true,
        isActive: true,
        lastSyncAt: true,
      },
    });

    if (!device) {
      sendError(
        res,
        backendFail(
          req,
          deviceIdParam,
          401,
          'device_config_not_found',
          `Device configuration with id ${deviceIdParam} not found`,
          [
            ...BACKEND_SYNC_CHECKS.deviceId,
            'Create the device in FitNix admin before syncing from the tablet',
            'Confirm you are pointing at the correct backend environment (prod vs staging)',
          ]
        )
      );
      return;
    }

    const gym = await prisma.gym.findUnique({
      where: { id: device.gymId },
      select: { id: true, tenantStatus: true, syncApiKey: true, name: true },
    });

    if (!gym) {
      sendError(
        res,
        backendFail(
          req,
          deviceIdParam,
          401,
          'gym_not_found',
          'Gym not found for this device configuration',
          [
            'Device row exists but its gym was removed — recreate the device in admin',
            ...BACKEND_SYNC_CHECKS.deviceId,
          ],
          { gymId: device.gymId }
        )
      );
      return;
    }

    const authMeta: SyncDiagnosticAuth = {
      gymHasSyncKey: Boolean(gym.syncApiKey),
      envKeyConfigured: Boolean(process.env.OFFLINE_SYNC_API_KEY),
    };

    if (gym.tenantStatus === 'SUSPENDED') {
      sendError(
        res,
        backendFail(
          req,
          deviceIdParam,
          403,
          'gym_suspended',
          `Gym "${gym.name}" is suspended. Sync is disabled.`,
          [
            ...BACKEND_SYNC_CHECKS.gym,
            'Contact FitNix support or platform admin to reactivate the gym',
          ],
          { gymId: gym.id, auth: authMeta }
        )
      );
      return;
    }

    const gymKey = gym.syncApiKey;
    const envKey = process.env.OFFLINE_SYNC_API_KEY;

    if (gymKey) {
      authMeta.keySource = 'gym_sync_api_key';
      if (apiKey !== gymKey) {
        sendError(
          res,
          backendFail(
            req,
            deviceIdParam,
            401,
            'invalid_api_key',
            'Invalid API key — does not match this gym sync key',
            [
              ...BACKEND_SYNC_CHECKS.apiKey,
              'This gym uses a per-gym syncApiKey (not the legacy server env key)',
              'Regenerate the key in admin only if compromised, then update the tablet',
            ],
            { gymId: gym.id, auth: authMeta }
          )
        );
        return;
      }
      req.syncKeySource = 'gym_sync_api_key';
    } else if (envKey) {
      authMeta.keySource = 'env_offline_sync_api_key';
      if (apiKey !== envKey) {
        sendError(
          res,
          backendFail(
            req,
            deviceIdParam,
            401,
            'invalid_api_key',
            'Invalid API key — does not match server OFFLINE_SYNC_API_KEY',
            [
              ...BACKEND_SYNC_CHECKS.apiKey,
              'No per-gym sync key is set; server is using legacy OFFLINE_SYNC_API_KEY env var',
              'Prefer generating a per-gym key in Tablet sync setup',
            ],
            { gymId: gym.id, auth: authMeta }
          )
        );
        return;
      }
      req.syncKeySource = 'env_offline_sync_api_key';
    } else {
      authMeta.keySource = 'none';
      sendError(
        res,
        backendFail(
          req,
          deviceIdParam,
          401,
          'sync_not_configured',
          'Tablet sync is not configured for this gym. Generate a sync key in gym settings.',
          [
            'Open FitNix admin → Devices → Tablet sync setup → generate sync key',
            'Paste that key into the tablet API key field',
            ...BACKEND_SYNC_CHECKS.gym,
          ],
          { gymId: gym.id, auth: authMeta }
        )
      );
      return;
    }

    req.deviceId = device.id;
    req.gymId = device.gymId;

    next();
  } catch (error) {
    const deviceIdParam = parseInt(req.params.id, 10) || -1;
    const diagnostic = buildSyncDiagnostic({
      title: 'BACKEND TEST FAILED',
      cause: 'server_error',
      mode: 'API_KEY',
      deviceConfigId: deviceIdParam,
      url: buildOfflineSyncUrl(req, deviceIdParam, stripDeviceIdPrefix(req.path)),
      httpStatus: 500,
      message: error instanceof Error ? error.message : 'Unexpected server error during API key auth',
      checks: [
        'Retry in a few seconds',
        'If this persists, the server or database may be unavailable',
        ...BACKEND_SYNC_CHECKS.network,
      ],
    });
    sendError(
      res,
      new UnauthorizedError(diagnostic.message, diagnosticDetails(diagnostic))
    );
  }
}
