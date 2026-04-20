import express, { type Express } from 'express';

/**
 * Vercel expects `export default` to be an Express `Application` (not a raw Node handler).
 * Register `/api/_diag/structure` first so it never loads `src/server` / Prisma.
 */
const root = express();
root.disable('x-powered-by');

root.get('/api/_diag/structure', (_req, res) => {
  res.status(200).json({
    ok: true,
    entry: 'api/index-express-wrapper',
    hint: 'If you see this, the entry file ran without importing src/server.ts for this path.',
    time: new Date().toISOString(),
  });
});

let fullStack: Express | null = null;
function getFullStack(): Express {
  if (!fullStack) {
    /* eslint-disable @typescript-eslint/no-var-requires */
    fullStack = require('../src/server').default as Express;
    /* eslint-enable @typescript-eslint/no-var-requires */
  }
  return fullStack;
}

root.use((req, res, next) => {
  getFullStack()(req, res, next);
});

export default root;
