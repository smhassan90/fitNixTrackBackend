/**
 * In-memory lockout for platform login (per IP + normalized email).
 * Resets on process restart; use Redis in production if needed.
 */

const failures = new Map<string, { count: number; lockedUntilMs: number }>();

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function key(ip: string, email: string): string {
  return `${ip}::${email.toLowerCase().trim()}`;
}

export function getClientIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) {
    return xf.split(',')[0].trim();
  }
  if (Array.isArray(xf) && xf[0]) {
    return String(xf[0]).split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

export function assertPlatformLoginAllowed(ip: string, email: string): void {
  const k = key(ip, email);
  const row = failures.get(k);
  if (!row) return;
  if (Date.now() < row.lockedUntilMs) {
    const err = new Error('Too many failed login attempts. Try again later.');
    (err as Error & { statusCode: number; code: string }).statusCode = 429;
    (err as Error & { statusCode: number; code: string }).code = 'RATE_LIMITED';
    throw err;
  }
}

export function recordPlatformLoginFailure(ip: string, email: string): void {
  const k = key(ip, email);
  const row = failures.get(k) || { count: 0, lockedUntilMs: 0 };
  if (Date.now() >= row.lockedUntilMs) {
    row.count = 0;
    row.lockedUntilMs = 0;
  }
  row.count += 1;
  if (row.count >= MAX_ATTEMPTS) {
    row.lockedUntilMs = Date.now() + LOCKOUT_MS;
  }
  failures.set(k, row);
}

export function clearPlatformLoginFailures(ip: string, email: string): void {
  failures.delete(key(ip, email));
}
