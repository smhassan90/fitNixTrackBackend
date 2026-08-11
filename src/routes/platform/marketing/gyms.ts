import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { PlatformRequest, requirePlatformRole } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import { marketingGymListQuerySchema } from '../../../validations/marketing';
import { listMarketingGyms } from '../../../services/marketing/marketingOverviewService';

const router = Router();

router.get(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(marketingGymListQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as { page?: number; limit?: number; search?: string };
      const data = await listMarketingGyms({
        page: typeof q.page === 'number' ? q.page : 1,
        limit: typeof q.limit === 'number' ? q.limit : 20,
        search: q.search,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
