import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { PLATFORM_PERMISSION_DEFINITIONS } from '../../constants/platformPermissions';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import { sendSuccess } from '../../utils/response';

const router = Router();

/**
 * Permission catalog for the platform portal (any active platform JWT).
 */
router.get(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT),
  (_req: PlatformRequest, res: Response) => {
    sendSuccess(res, { permissions: PLATFORM_PERMISSION_DEFINITIONS });
  }
);

export default router;
