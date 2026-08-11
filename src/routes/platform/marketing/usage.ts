import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingUsageQuerySchema,
  marketingAuditLogQuerySchema,
} from '../../../validations/marketing';
import {
  getMarketingUsage,
  getMarketingAuditLog,
} from '../../../services/marketing/marketingUsageService';

const router = Router();

router.get(
  '/usage',
  validate(marketingUsageQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as { gymId: string; from: string; to: string };
      const data = await getMarketingUsage({
        gymId: Number(q.gymId),
        from: q.from,
        to: q.to,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/audit-log',
  validate(marketingAuditLogQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as {
        gymId: string;
        page?: string;
        limit?: string;
        actionType?: string;
      };
      const data = await getMarketingAuditLog({
        gymId: Number(q.gymId),
        page: Number(q.page) || 1,
        limit: Number(q.limit) || 20,
        actionType: q.actionType,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
