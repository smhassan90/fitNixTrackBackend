import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingOpportunityIdParamSchema,
  marketingRejectOpportunitySchema,
  marketingGenerateSocialPostSchema,
} from '../../../validations/marketing';
import {
  getOpportunityById,
  approveOpportunity,
  rejectOpportunity,
} from '../../../services/marketing/marketingOpportunityService';
import { generateSocialPostFromOpportunity } from '../../../services/marketing/marketingContentService';

const router = Router();

router.get(
  '/:id',
  validate(marketingOpportunityIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const data = await getOpportunityById(id);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/approve',
  validate(marketingOpportunityIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const data = await approveOpportunity({
        id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Opportunity approved');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/reject',
  validate(marketingRejectOpportunitySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as { reason?: string };
      const data = await rejectOpportunity({
        id,
        reason: body.reason,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Opportunity rejected');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

/** Requires opportunity status APPROVED first. */
router.post(
  '/:id/generate-social-post',
  validate(marketingGenerateSocialPostSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as { notes?: string };
      const data = await generateSocialPostFromOpportunity({
        opportunityId: id,
        notes: body.notes,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Social post draft created');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
