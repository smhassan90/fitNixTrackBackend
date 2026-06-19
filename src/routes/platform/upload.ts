import { Router, Response } from 'express';
import type { PlatformRequest } from '../../middleware/platformAuth';
import { requirePlatformRole } from '../../middleware/platformAuth';
import { handleLogoUpload } from '../../middleware/gymLogoMultipart';

const router = Router();
const writeRoles = ['SUPER_ADMIN', 'PLATFORM_SUPPORT'] as const;

router.post('/logo', requirePlatformRole(...writeRoles), (req: PlatformRequest, res: Response) => {
  handleLogoUpload(req, res);
});

export default router;
