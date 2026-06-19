import type { SignOptions } from 'jsonwebtoken';

/**
 * JWT sign options. When no expiry env is set (or value is `never` / `0`), tokens do not expire.
 * Explicit logout still works via tokenVersion invalidation.
 */
export function jwtSignOptions(
  specificEnv?: string,
  sharedEnv?: string
): SignOptions {
  const raw = specificEnv?.trim() || sharedEnv?.trim();
  if (!raw || raw.toLowerCase() === 'never' || raw === '0') {
    return {};
  }
  return { expiresIn: raw as SignOptions['expiresIn'] };
}
