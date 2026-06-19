import type { SignOptions, VerifyOptions } from 'jsonwebtoken';

function resolveExpiryEnv(specificEnv?: string, sharedEnv?: string): string | undefined {
  const raw = specificEnv?.trim() || sharedEnv?.trim();
  if (!raw || raw.toLowerCase() === 'never' || raw === '0') {
    return undefined;
  }
  return raw;
}

/** Platform uses PLATFORM_JWT_EXPIRES_IN only — not gym JWT_EXPIRES_IN. */
export function platformSessionNeverExpires(): boolean {
  return resolveExpiryEnv(process.env.PLATFORM_JWT_EXPIRES_IN) === undefined;
}

/**
 * JWT sign options. When no expiry env is set (or value is `never` / `0`), tokens do not expire.
 * Explicit logout still works via tokenVersion invalidation.
 */
export function jwtSignOptions(
  specificEnv?: string,
  sharedEnv?: string
): SignOptions {
  const expiry = resolveExpiryEnv(specificEnv, sharedEnv);
  if (!expiry) {
    return {};
  }
  return { expiresIn: expiry as SignOptions['expiresIn'] };
}

/** Platform login — never expires unless PLATFORM_JWT_EXPIRES_IN is set. */
export function platformJwtSignOptions(): SignOptions {
  return jwtSignOptions(process.env.PLATFORM_JWT_EXPIRES_IN);
}

/**
 * Platform verify — in never-expire mode, ignore JWT `exp` so old short-lived tokens keep working.
 * Sessions are invalidated only by explicit logout (tokenVersion), deactivation, or bad signature.
 */
export function platformJwtVerifyOptions(): VerifyOptions {
  if (platformSessionNeverExpires()) {
    return { ignoreExpiration: true };
  }
  return {};
}
