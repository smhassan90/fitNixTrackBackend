import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingSocialAccountsQuerySchema,
  marketingSocialConnectSchema,
  marketingSocialDisconnectSchema,
} from '../../../validations/marketing';
import {
  listSocialAccounts,
  startSocialOAuthConnect,
  disconnectSocialAccount,
} from '../../../services/marketing/marketingSocialAccountService';

const router = Router({ mergeParams: true });

router.get(
  '/',
  validate(marketingSocialAccountsQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const data = await listSocialAccounts(gymId);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/connect',
  validate(marketingSocialConnectSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const user = req.platformUser!;
      const body = req.body as { platform: string };
      const data = await startSocialOAuthConnect({
        gymId,
        platform: body.platform,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/:accountId',
  validate(marketingSocialDisconnectSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const accountId = Number(req.params.accountId);
      const user = req.platformUser!;
      const data = await disconnectSocialAccount({
        gymId,
        accountId,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Social account disconnected');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
