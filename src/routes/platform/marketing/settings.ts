import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import { marketingSettingsUpdateSchema } from '../../../validations/marketing';
import {
  getMarketingSettingsPublic,
  updateMarketingSettings,
} from '../../../services/marketing/marketingSettingsService';

const router = Router();

router.get('/', async (req: PlatformRequest, res: Response) => {
  try {
    const data = await getMarketingSettingsPublic();
    sendSuccess(res, data);
  } catch (error) {
    sendError(res, error as Error);
  }
});

router.put(
  '/',
  validate(marketingSettingsUpdateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const user = req.platformUser!;
      const data = await updateMarketingSettings({
        patch: req.body,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Marketing settings saved');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
