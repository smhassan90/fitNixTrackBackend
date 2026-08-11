import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { PlatformRequest, requirePlatformRole } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import { marketingGymIdParamSchema } from '../../../validations/marketing';
import { getMarketingOverview } from '../../../services/marketing/marketingOverviewService';

const router = Router({ mergeParams: true });

router.get(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(marketingGymIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const data = await getMarketingOverview(gymId);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
