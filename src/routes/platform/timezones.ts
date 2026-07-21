import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { requirePlatformRole, PlatformRequest } from '../../middleware/platformAuth';
import { listIanaTimezones } from '../../services/gymTimezoneService';
import { sendSuccess, sendError } from '../../utils/response';

const router = Router();

const readRoles = [PlatformRole.SUPER_ADMIN, PlatformRole.PLATFORM_SUPPORT] as const;

router.get(
  '/',
  requirePlatformRole(...readRoles),
  async (_req: PlatformRequest, res: Response) => {
    try {
      sendSuccess(res, { timezones: listIanaTimezones() });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
