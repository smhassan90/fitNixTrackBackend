import { Router, Response } from 'express';
import { validate } from '../../middleware/validation';
import {
  authenticatePlatformToken,
  PlatformRequest,
  requirePlatformRole,
} from '../../middleware/platformAuth';
import {
  getAccountDeletionRequestSchema,
  listAccountDeletionRequestsSchema,
  updateAccountDeletionRequestSchema,
} from '../../validations/accountDeletion';
import {
  getAccountDeletionRequest,
  listAccountDeletionRequests,
  updateAccountDeletionRequest,
} from '../../services/accountDeletionService';
import { sendSuccess, sendError, buildPagination } from '../../utils/response';

const router = Router();

router.use(authenticatePlatformToken);

router.get(
  '/',
  requirePlatformRole('SUPER_ADMIN', 'PLATFORM_SUPPORT'),
  validate(listAccountDeletionRequestsSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const q = req.query as {
        status?: 'pending' | 'in_progress' | 'completed' | 'rejected' | 'cancelled';
        page?: number;
        limit?: number;
        search?: string;
      };
      const result = await listAccountDeletionRequests(q);
      sendSuccess(res, {
        requests: result.requests,
        pagination: buildPagination(result.page, result.limit, result.total),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/:id',
  requirePlatformRole('SUPER_ADMIN', 'PLATFORM_SUPPORT'),
  validate(getAccountDeletionRequestSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const row = await getAccountDeletionRequest(String(req.params.id));
      sendSuccess(res, { request: row });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id',
  requirePlatformRole('SUPER_ADMIN'),
  validate(updateAccountDeletionRequestSchema),
  async (req: PlatformRequest, res: Response) => {
    try {
      const u = req.platformUser!;
      const updated = await updateAccountDeletionRequest(String(req.params.id), req.body, {
        platformUserId: u.id,
        email: u.email,
        name: u.name,
      });
      sendSuccess(res, { request: updated }, 'Deletion request updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
