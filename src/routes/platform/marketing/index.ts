import { Router } from 'express';
import { PlatformRole } from '@prisma/client';
import { requirePlatformRole } from '../../../middleware/platformAuth';
import gymsRoutes from './gyms';
import overviewRoutes from './overview';
import profileRoutes from './profile';

const router = Router();

// Phase 1: Super Admin only (no PLATFORM_SUPPORT reads).
router.use(requirePlatformRole(PlatformRole.SUPER_ADMIN));

router.use('/gyms', gymsRoutes);
router.use('/gyms/:gymId/overview', overviewRoutes);
router.use('/gyms/:gymId/profile', profileRoutes);

export default router;
