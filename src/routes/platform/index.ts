import { Router } from 'express';
import { authenticatePlatformToken } from '../../middleware/platformAuth';
import authRoutes from './auth';
import gymRoutes from './gyms';
import billingRoutes from './billing';
import reportRoutes from './reports';
import auditRoutes from './auditLogs';

const router = Router();

router.use('/auth', authRoutes);
router.use('/gyms', authenticatePlatformToken, gymRoutes);
router.use('/billing', authenticatePlatformToken, billingRoutes);
router.use('/reports', authenticatePlatformToken, reportRoutes);
router.use('/audit-logs', authenticatePlatformToken, auditRoutes);

export default router;
