import { Router, Response } from 'express';
import { PlatformRequest } from '../../../middleware/platformAuth';
import { validate } from '../../../middleware/validation';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  marketingBlogListQuerySchema,
  marketingGenerateBlogSchema,
} from '../../../validations/marketing';
import { listBlogs, generateBlog } from '../../../services/marketing/marketingBlogService';

const router = Router({ mergeParams: true });

router.get(
  '/',
  validate(marketingBlogListQuerySchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const q = req.query as { status?: string; page?: string; limit?: string };
      const data = await listBlogs({
        gymId,
        status: q.status,
        page: Number(q.page) || 1,
        limit: Number(q.limit) || 20,
      });
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/generate',
  validate(marketingGenerateBlogSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const gymId = Number(req.params.gymId);
      const user = req.platformUser!;
      const body = (req.body ?? {}) as {
        topic?: string;
        targetKeyword?: string;
        opportunityId?: number;
      };
      const data = await generateBlog({
        gymId,
        topic: body.topic,
        targetKeyword: body.targetKeyword,
        opportunityId: body.opportunityId,
        actorUserId: user.id,
        actorRole: user.role,
      });
      sendSuccess(res, data, 'Blog draft generated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
