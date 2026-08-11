import { Router, Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { PlatformRequest, requirePlatformRole } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingGymIdParamSchema,
  marketingProfileUpdateSchema,
  MarketingProfileField,
} from '../../../validations/marketing';
import {
  getOrCreateMarketingProfile,
  updateMarketingProfile,
} from '../../../services/marketing/marketingProfileService';
import { writePlatformAuditLog } from '../../../services/platformAuditService';

const router = Router({ mergeParams: true });

router.get(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(marketingGymIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const { dto, created } = await getOrCreateMarketingProfile(gymId);
      if (created && req.platformUser) {
        await writePlatformAuditLog({
          actorUserId: req.platformUser.id,
          actorRole: req.platformUser.role,
          actionType: 'MARKETING_PROFILE_CREATE',
          targetGymId: gymId,
          metadata: { source: 'GET_SEED', changedFields: ['city', 'country', 'address', 'phone', 'location'] },
        });
      }
      sendSuccess(res, dto);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.put(
  '/',
  requirePlatformRole(PlatformRole.SUPER_ADMIN),
  validate(marketingProfileUpdateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const user = req.platformUser!;
      const patch = req.body as Partial<Record<MarketingProfileField, string | null>>;
      const dto = await updateMarketingProfile({
        gymId,
        actorUserId: user.id,
        actorRole: user.role,
        patch,
      });
      sendSuccess(res, dto, 'Marketing profile saved');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
