import { Router } from 'express';
import { PlatformRole } from '@prisma/client';
import { requirePlatformRole } from '../../../middleware/platformAuth';
import gymsRoutes from './gyms';
import overviewRoutes from './overview';
import profileRoutes from './profile';
import opportunitiesRoutes from './opportunities';
import opportunityActionsRoutes from './opportunityActions';
import contentsRoutes from './contents';
import contentActionsRoutes from './contentActions';

const router = Router();

// Phase 1–2: Super Admin only (no PLATFORM_SUPPORT reads).
router.use(requirePlatformRole(PlatformRole.SUPER_ADMIN));

router.use('/gyms', gymsRoutes);
router.use('/gyms/:gymId/overview', overviewRoutes);
router.use('/gyms/:gymId/profile', profileRoutes);
router.use('/gyms/:gymId/opportunities', opportunitiesRoutes);
router.use('/gyms/:gymId/contents', contentsRoutes);
router.use('/opportunities', opportunityActionsRoutes);
router.use('/contents', contentActionsRoutes);

export default router;
