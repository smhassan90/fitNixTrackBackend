import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { sendError } from '../utils/response';

export interface ApiKeyAuthRequest extends Request {
  deviceId?: number;
  gymId?: number;
}

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
    const apiKey = req.body?.apiKey || req.headers['x-api-key'] as string;
    
    if (!apiKey) {
      sendError(res, new UnauthorizedError('API key is required'));
      return;
    }

    // Get device ID from params
    const deviceId = parseInt(req.params.id, 10);
    if (isNaN(deviceId)) {
      sendError(res, new UnauthorizedError('Invalid device ID'));
      return;
    }

    // Get device configuration
    const device = await prisma.deviceConfig.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        gymId: true,
        // You can add an apiKey field to deviceConfig if needed
        // For now, we'll use a simple environment variable approach
      },
    });

    if (!device) {
      sendError(res, new UnauthorizedError('Device not found'));
      return;
    }

    const gym = await prisma.gym.findUnique({
      where: { id: device.gymId },
      select: { tenantStatus: true },
    });
    if (!gym) {
      sendError(res, new UnauthorizedError('Gym not found for this device'));
      return;
    }
    if (gym.tenantStatus === 'SUSPENDED') {
      sendError(
        res,
        new ForbiddenError('This gym account is suspended. Sync is disabled.')
      );
      return;
    }

    // Validate API key
    // Option 1: Use environment variable (simple)
    const validApiKey = process.env.OFFLINE_SYNC_API_KEY;
    if (validApiKey && apiKey !== validApiKey) {
      sendError(res, new UnauthorizedError('Invalid API key'));
      return;
    }

    // Option 2: If you want per-device API keys, add apiKey field to DeviceConfig
    // if (device.apiKey && apiKey !== device.apiKey) {
    //   sendError(res, new UnauthorizedError('Invalid API key'));
    //   return;
    // }

    // Attach device info to request
    req.deviceId = device.id;
    req.gymId = device.gymId;

    next();
  } catch (error) {
    sendError(res, error as Error);
  }
}

