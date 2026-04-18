import rateLimit from 'express-rate-limit';

/** Stricter limit for platform admin login only. */
export const platformLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many platform login attempts from this IP. Try again later.',
});
