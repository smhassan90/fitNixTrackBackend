import { Router, Request, Response } from 'express';
import { validate } from '../../../middleware/validation';
import { marketingOAuthCallbackQuerySchema } from '../../../validations/marketing';
import { handleSocialOAuthCallback } from '../../../services/marketing/marketingSocialAccountService';
import { buildPortalMarketingErrorRedirect } from '../../../services/marketing/socialProviders/oauthUrls';

const router = Router();

/**
 * Provider redirect target — NO platform JWT.
 * GET /api/platform/marketing/oauth/:platform/callback
 */
router.get(
  '/:platform/callback',
  validate(marketingOAuthCallbackQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const platform = String(req.params.platform);
      const q = req.query as {
        code?: string;
        state?: string;
        error?: string;
        error_description?: string;
      };
      const redirectTo = await handleSocialOAuthCallback({
        platform,
        code: q.code,
        state: q.state,
        error: q.error,
        errorDescription: q.error_description,
      });
      res.redirect(302, redirectTo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OAuth failed';
      const platform = String(req.params.platform || 'unknown');
      try {
        const url = await buildPortalMarketingErrorRedirect({ platform, message });
        res.redirect(302, url);
      } catch {
        res.status(500).send(`OAuth error: ${message}`);
      }
    }
  }
);

export default router;
