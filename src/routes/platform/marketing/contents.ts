import { Router, Response } from 'express';
import { MarketingContentStatus } from '@prisma/client';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import { marketingContentListQuerySchema } from '../../../validations/marketing';
import { listContents } from '../../../services/marketing/marketingContentService';

const router = Router({ mergeParams: true });

router.get(
  '/',
  validate(marketingContentListQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const q = req.query as {
        page?: number;
        limit?: number;
        status?: MarketingContentStatus;
        opportunityId?: number;
      };
      const data = await listContents({
        gymId,
        page: typeof q.page === 'number' ? q.page : 1,
        limit: typeof q.limit === 'number' ? q.limit : 20,
        status: q.status,
        opportunityId: q.opportunityId,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
