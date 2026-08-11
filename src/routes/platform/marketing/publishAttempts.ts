import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import { marketingPublishAttemptIdParamSchema } from '../../../validations/marketing';
import { retryPublishAttempt } from '../../../services/marketing/marketingPublishService';

const router = Router();

router.post(
  '/:id/retry',
  validate(marketingPublishAttemptIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const data = await retryPublishAttempt({
        attemptId: id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Publish retry completed');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
