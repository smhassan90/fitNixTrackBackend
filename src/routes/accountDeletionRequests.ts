import { Router, Response, Request } from 'express';
import { validate } from '../middleware/validation';
import { accountDeletionRateLimiter } from '../middleware/accountDeletionRateLimit';
import { createAccountDeletionRequestSchema } from '../validations/accountDeletion';
import { createAccountDeletionRequest } from '../services/accountDeletionService';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

function clientIp(req: Request): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim().slice(0, 64);
  }
  return req.ip?.slice(0, 64) || null;
}

/**
 * Public Google Play account deletion form.
 * POST /api/account-deletion-requests
 */
router.post(
  '/',
  accountDeletionRateLimiter,
  validate(createAccountDeletionRequestSchema),
  async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        fullName: string;
        email?: string | null;
        phone?: string | null;
        accountType: 'member' | 'trainer' | 'other';
        gymName?: string | null;
        reason?: string | null;
        source?: 'web' | 'app';
      };

      const result = await createAccountDeletionRequest({
        fullName: body.fullName,
        email: body.email,
        phone: body.phone,
        accountType: body.accountType,
        gymName: body.gymName,
        reason: body.reason,
        source: body.source ?? 'web',
        requesterIp: clientIp(req),
      });

      sendSuccess(res, result, undefined, 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
