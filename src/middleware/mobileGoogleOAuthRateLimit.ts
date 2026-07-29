import rateLimit from 'express-rate-limit';

/** Limit PKCE OAuth start requests to reduce abuse. */
export const mobileGoogleOAuthStartRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many Google sign-in attempts from this IP. Try again in a minute.',
});
