import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Vercel entry: avoid importing `src/server` or `src/lib/prisma` for `/api/_diag/structure`
 * so we can tell import-time crashes from request-time crashes.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = String(req.url ?? '');

  if (url.includes('/api/_diag/structure')) {
    const body = JSON.stringify({
      ok: true,
      entry: 'api/index-bypass',
      hint: 'If you see this JSON, the Lambda boots and this file runs without loading src/server.ts.',
      url,
      time: new Date().toISOString(),
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
    return;
  }

  /* eslint-disable @typescript-eslint/no-var-requires -- load full Express app only when needed */
  const app = require('../src/server').default as (req: IncomingMessage, res: ServerResponse) => void;
  /* eslint-enable @typescript-eslint/no-var-requires */
  app(req, res);
}
