import { Router, Request, Response } from 'express';
import { sendSuccess, sendError } from '../../../utils/response';
import { listWebsitePublishedBlogs } from '../../../services/marketing/marketingBlogService';

const router = Router();

/**
 * Public read of website-shaped blog posts (no secrets).
 * Website can fetch instead of (or in addition to) the JSON export file.
 * GET /api/platform/marketing/website-blogs
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const posts = await listWebsitePublishedBlogs();
    sendSuccess(res, { posts });
  } catch (error) {
    sendError(res, error as Error);
  }
});

export default router;
