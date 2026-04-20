import { Router, Request, Response } from 'express';

/**
 * TEMP: Minimal platform surface for Vercel diagnosis (no Prisma, bcrypt, JWT, zod, audit).
 * Remove once FUNCTION_INVOCATION_FAILED root cause is fixed.
 */
const router = Router();

router.post('/auth/login', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      diag: 'platform-login-stub',
      hint: 'If you see this JSON on Vercel, the crash was in real platform/auth or other platform routes — not global Express.',
    },
  });
});

export default router;
