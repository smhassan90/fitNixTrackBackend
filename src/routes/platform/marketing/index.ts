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
import socialAccountsRoutes from './socialAccounts';
import settingsRoutes from './settings';
import publishAttemptsRoutes from './publishAttempts';
import calendarRoutes from './calendar';
import blogsRoutes from './blogs';
import blogActionsRoutes from './blogActions';
import usageRoutes from './usage';
import jobsRoutes from './jobs';

const router = Router();

// Phase 1–7: Super Admin only (no PLATFORM_SUPPORT / gym JWT).
router.use(requirePlatformRole(PlatformRole.SUPER_ADMIN));

router.use('/settings', settingsRoutes);
router.use('/gyms', gymsRoutes);
router.use('/gyms/:gymId/overview', overviewRoutes);
router.use('/gyms/:gymId/profile', profileRoutes);
router.use('/gyms/:gymId/opportunities', opportunitiesRoutes);
router.use('/gyms/:gymId/contents', contentsRoutes);
router.use('/gyms/:gymId/social-accounts', socialAccountsRoutes);
router.use('/gyms/:gymId/blogs', blogsRoutes);
router.use('/opportunities', opportunityActionsRoutes);
router.use('/contents', contentActionsRoutes);
router.use('/blogs', blogActionsRoutes);
router.use('/publish-attempts', publishAttemptsRoutes);
router.use('/calendar', calendarRoutes);
router.use('/jobs', jobsRoutes);
router.use('/', usageRoutes);

export default router;
