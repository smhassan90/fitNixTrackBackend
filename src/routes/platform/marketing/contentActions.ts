import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingContentIdParamSchema,
  marketingContentUpdateSchema,
  marketingRejectContentSchema,
  marketingGenerateImagePromptSchema,
  marketingGenerateImageSchema,
  marketingRegenerateImageSchema,
  marketingImageVersionParamSchema,
  marketingRejectImageSchema,
} from '../../../validations/marketing';
import {
  getContentById,
  updateContent,
  submitContentForApproval,
  approveContent,
  rejectContent,
  CONTENT_EDITABLE_FIELDS,
} from '../../../services/marketing/marketingContentService';
import {
  generateImagePromptForContent,
  generateImageForContent,
  regenerateImageForContent,
  listImageVersions,
  approveImageVersion,
  rejectImageVersion,
} from '../../../services/marketing/marketingImageService';

const router = Router();

router.get(
  '/:id',
  validate(marketingContentIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const data = await getContentById(id);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.put(
  '/:id',
  validate(marketingContentUpdateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = req.body as Record<string, unknown>;
      const patch: Partial<Record<(typeof CONTENT_EDITABLE_FIELDS)[number], unknown>> = {};
      for (const key of CONTENT_EDITABLE_FIELDS) {
        if (key in body) patch[key] = body[key];
      }
      const data = await updateContent({
        id,
        patch,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Content updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/submit-for-approval',
  validate(marketingContentIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const data = await submitContentForApproval({
        id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Content submitted for approval');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/approve',
  validate(marketingContentIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const data = await approveContent({
        id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Content approved');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/reject',
  validate(marketingRejectContentSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as { reason?: string };
      const data = await rejectContent({
        id,
        reason: body.reason,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Content rejected');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/generate-image-prompt',
  validate(marketingGenerateImagePromptSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as { notes?: string };
      const data = await generateImagePromptForContent({
        contentId: id,
        notes: body.notes,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Image prompt generated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/generate-image',
  validate(marketingGenerateImageSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as { prompt?: string };
      const data = await generateImageForContent({
        contentId: id,
        prompt: body.prompt,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Image generated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/regenerate-image',
  validate(marketingRegenerateImageSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = req.body as {
        mode: 'quick' | 'custom';
        instructions?: string;
        prompt?: string;
      };
      const data = await regenerateImageForContent({
        contentId: id,
        mode: body.mode,
        instructions: body.instructions,
        prompt: body.prompt,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Image regenerated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/:id/images',
  validate(marketingContentIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const data = await listImageVersions(id);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/images/:imageVersionId/approve',
  validate(marketingImageVersionParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const imageVersionId = Number(req.params.imageVersionId);
      const user = req.platformUser!;
      const data = await approveImageVersion({
        contentId: id,
        imageVersionId,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Image version approved');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/images/:imageVersionId/reject',
  validate(marketingRejectImageSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const imageVersionId = Number(req.params.imageVersionId);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as { reason?: string };
      const data = await rejectImageVersion({
        contentId: id,
        imageVersionId,
        reason: body.reason,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Image version rejected');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
