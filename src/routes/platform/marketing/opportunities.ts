import { Router, Response } from 'express';
import { MarketingOpportunityStatus } from '@prisma/client';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingOpportunityListQuerySchema,
  marketingGenerateOpportunitiesSchema,
} from '../../../validations/marketing';
import {
  listOpportunities,
  generateAndStoreOpportunities,
} from '../../../services/marketing/marketingOpportunityService';

const router = Router({ mergeParams: true });

router.get(
  '/',
  validate(marketingOpportunityListQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const q = req.query as {
        page?: number;
        limit?: number;
        status?: MarketingOpportunityStatus;
      };
      const data = await listOpportunities({
        gymId,
        page: typeof q.page === 'number' ? q.page : 1,
        limit: typeof q.limit === 'number' ? q.limit : 20,
        status: q.status,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/generate',
  validate(marketingGenerateOpportunitiesSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as { count?: number; focus?: string };
      const data = await generateAndStoreOpportunities({
        gymId,
        count: body.count,
        focus: body.focus,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Opportunities generated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
