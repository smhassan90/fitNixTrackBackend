import rateLimit from 'express-rate-limit';

/** Public account-deletion form: 5 requests per IP per hour. */
export const accountDeletionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many deletion requests from this IP. Please try again later.',
    },
  },
});
