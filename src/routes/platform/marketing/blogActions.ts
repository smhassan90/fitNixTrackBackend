import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingBlogIdParamSchema,
  marketingBlogUpdateSchema,
  MARKETING_BLOG_EDITABLE_FIELDS,
} from '../../../validations/marketing';
import {
  getBlogById,
  updateBlog,
  approveBlog,
  publishBlogToWebsite,
} from '../../../services/marketing/marketingBlogService';

const router = Router();

router.get(
  '/:id',
  validate(marketingBlogIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const data = await getBlogById(Number(req.params.id));
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.put(
  '/:id',
  validate(marketingBlogUpdateSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = req.platformUser!;
      const body = req.body as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of MARKETING_BLOG_EDITABLE_FIELDS) {
        if (key in body) patch[key] = body[key];
      }
      const data = await updateBlog({
        id,
        patch,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Blog updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/approve',
  validate(marketingBlogIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const user = req.platformUser!;
      const data = await approveBlog({
        id: Number(req.params.id),
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Blog approved');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/:id/publish-to-website',
  validate(marketingBlogIdParamSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const user = req.platformUser!;
      const data = await publishBlogToWebsite({
        id: Number(req.params.id),
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Blog published to website');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
