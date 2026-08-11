import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { sendSuccess, sendError } from '../../../utils/response';
import { processDueScheduledContent } from '../../../services/marketing/marketingPublishService';

const router = Router();

/**
 * Process due SCHEDULED content (V1 — no Redis/Kafka).
 * On Vercel, call this from a cron (e.g. every 1–5 min).
 * Locally, server.ts also runs a simple interval when not on Vercel.
 * Never auto-publishes without a prior explicit schedule/publish selection.
 */
router.post('/process-due-schedules', async (req: PlatformRequest, res: Response) => {
  try {
    const data = await processDueScheduledContent();
    sendSuccess(res, data, `Processed ${data.processed} due schedule(s)`);
  } catch (error) {
    sendError(res, error as Error);
  }
});

export default router;
