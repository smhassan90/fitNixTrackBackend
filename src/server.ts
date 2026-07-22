import express, { Express, Router } from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { errorHandler } from './middleware/errorHandler';
import { prisma } from './lib/prisma';

// Routes
import authRoutes from './routes/auth';
import memberRoutes from './routes/members';
import trainerRoutes from './routes/trainers';
import packageRoutes from './routes/packages';
import paymentRoutes from './routes/payments';
import attendanceRoutes from './routes/attendance';
import dashboardRoutes from './routes/dashboard';
import reportRoutes from './routes/reports';
import settingsRoutes from './routes/settings';
import platformRoutes from './routes/platform';
import gymUsersRoutes from './routes/gymUsers';
import importRoutes from './routes/import';
import posRoutes from './routes/pos';
import mobileRoutes from './routes/mobile';

// Load environment variables
dotenv.config();

/* Device routes pull `node-zklib` (native). Lazy-load so gym login and other APIs do not load it. */
let deviceRoutes: Router | null = null;
function getDeviceRoutes(): Router {
  if (!deviceRoutes) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    deviceRoutes = require('./routes/device').default as Router;
  }
  return deviceRoutes;
}

const app: Express = express();
const PORT = process.env.PORT || 3001;

// Vercel always sets X-Forwarded-For. express-rate-limit v7 throws if trust proxy stays false
// (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR). Use hop count, not boolean true (forbidden by rate-limit validations).
if (process.env.VERCEL === '1' || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 1000;
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Tablet/biometric offline sync endpoints are API-key authenticated and polled
  // frequently — don't count them against the per-IP browser limit.
  skip: (req) => /^\/api\/device\/\d+\/(sync-attendance-offline|sync-users-offline|test-backend-offline)$/.test(req.path),
  // Return JSON in the app's standard error shape (not a plain-text body),
  // so clients parsing { success, error } don't choke on a 429.
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests from this IP, please try again later.',
      },
    });
  },
});
app.use('/api/', limiter);

// Disable caching for API responses
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  next();
});

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Uploaded gym logos — Vercel FS is read-only except /tmp.
const uploadsRoot =
  process.env.VERCEL === '1'
    ? path.join('/tmp', 'fitnix-uploads')
    : path.join(process.cwd(), 'uploads');
try {
  fs.mkdirSync(path.join(uploadsRoot, 'logos'), { recursive: true });
  fs.mkdirSync(path.join(uploadsRoot, 'members'), { recursive: true });
} catch (err) {
  console.warn('Could not create uploads directory:', err);
}
app.use('/uploads', express.static(uploadsRoot));

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connectivity
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({ 
      status: 'ok', 
      database: 'connected',
      timestamp: new Date().toISOString() 
    });
  } catch (error: any) {
    const errorMessage = error?.message || 'Database connection failed';
    const errorCode = error?.code || 'UNKNOWN_ERROR';
    
    // Log full error for debugging (only in development)
    if (process.env.NODE_ENV === 'development') {
      console.error('Database connection error:', error);
    }
    
    res.status(503).json({ 
      status: 'error', 
      database: 'disconnected',
      error: errorMessage,
      code: errorCode,
      timestamp: new Date().toISOString(),
      // Only show details in development
      ...(process.env.NODE_ENV === 'development' && {
        details: {
          hasDatabaseUrl: !!process.env.DATABASE_URL,
          databaseUrlPrefix: process.env.DATABASE_URL?.substring(0, 10) || 'not set',
        }
      })
    });
  }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/trainers', trainerRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/device', (req, res, next) => getDeviceRoutes()(req, res, next));
app.use('/api/settings', settingsRoutes);
app.use('/api/import', importRoutes);
app.use('/api/gym', gymUsersRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/mobile', mobileRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server only if not in serverless environment (Vercel)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 CORS enabled for: ${process.env.CORS_ORIGIN || 'http://localhost:3000'}`);
  });
}

export default app;

