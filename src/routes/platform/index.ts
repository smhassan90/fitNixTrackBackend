import { Router } from 'express';
import { authenticatePlatformToken } from '../../middleware/platformAuth';
import authRoutes from './auth';
import gymRoutes from './gyms';
import billingRoutes from './billing';
import reportRoutes from './reports';
import auditRoutes from './auditLogs';
import userRoutes from './users';
import permissionRoutes from './permissions';
import locationRoutes from './locations';
import timezoneRoutes from './timezones';
import adminBillingPlanRoutes from './adminBillingPlans';
import adminPackageFeatureRoutes from './adminPackageFeatures';
import uploadRoutes from './upload';
import posRoutes from './pos';
import accountDeletionRequestRoutes from './accountDeletionRequests';
import marketingRoutes from './marketing';
import marketingOAuthCallbackRoutes from './marketing/oauthCallback';
import marketingWebsiteBlogsRoutes from './marketing/websiteBlogs';

const router = Router();

router.use('/auth', authRoutes);
router.use('/upload', authenticatePlatformToken, uploadRoutes);
router.use('/gyms', authenticatePlatformToken, gymRoutes);
router.use('/billing', authenticatePlatformToken, billingRoutes);
router.use('/reports', authenticatePlatformToken, reportRoutes);
router.use('/audit-logs', authenticatePlatformToken, auditRoutes);
router.use('/users', authenticatePlatformToken, userRoutes);
router.use('/permissions', authenticatePlatformToken, permissionRoutes);
router.use('/timezones', authenticatePlatformToken, timezoneRoutes);
router.use('/account-deletion-requests', accountDeletionRequestRoutes);
// OAuth provider callbacks must be public (no platform JWT on browser redirect).
router.use('/marketing/oauth', marketingOAuthCallbackRoutes);
// Public website blog feed (published posts only; no tokens).
router.use('/marketing/website-blogs', marketingWebsiteBlogsRoutes);
router.use('/marketing', authenticatePlatformToken, marketingRoutes);
router.use('/', authenticatePlatformToken, locationRoutes);
router.use('/', authenticatePlatformToken, adminBillingPlanRoutes);
router.use('/', authenticatePlatformToken, adminPackageFeatureRoutes);
router.use('/pos', authenticatePlatformToken, posRoutes);

export default router;
