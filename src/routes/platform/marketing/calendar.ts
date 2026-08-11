import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import { marketingCalendarQuerySchema } from '../../../validations/marketing';
import { getMarketingCalendar } from '../../../services/marketing/marketingPublishService';

const router = Router();

router.get(
  '/',
  validate(marketingCalendarQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as { gymId: string; from: string; to: string; view?: string };
      const data = await getMarketingCalendar({
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

export default router;
