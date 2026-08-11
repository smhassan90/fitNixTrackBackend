import crypto from 'crypto';
import { AppError, ValidationError } from '../../../utils/errors';
import { isMarketingSocialPlatform, MarketingSocialPlatform } from './types';

export type MarketingOAuthStatePayload = {
  gymId: number;
  platform: MarketingSocialPlatform;
  platformUserId: number;
  nonce: string;
  exp: number;
};

function stateSecret(): string {
  const s = process.env.JWT_SECRET?.trim() || '';
  if (!s) {
    throw new AppError(
      'OAUTH_MISCONFIGURED',
      'JWT_SECRET is required for OAuth state signing',
      503
    );
  }
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signMarketingOAuthState(params: {
  gymId: number;
  platform: MarketingSocialPlatform;
  platformUserId: number;
  ttlSeconds?: number;
}): string {
  const payload: MarketingOAuthStatePayload = {
    gymId: params.gymId,
    platform: params.platform,
    platformUserId: params.platformUserId,
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 600),
  };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', stateSecret())
    .update(`marketing-oauth:${body}`)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifyMarketingOAuthState(state: string): MarketingOAuthStatePayload {
  const [body, sig] = state.split('.');
  if (!body || !sig) {
    throw new ValidationError('Invalid OAuth state');
  }
  const expected = crypto
    .createHmac('sha256', stateSecret())
    .update(`marketing-oauth:${body}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ValidationError('Invalid OAuth state signature');
  }
  let payload: MarketingOAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MarketingOAuthStatePayload;
  } catch {
    throw new ValidationError('Invalid OAuth state payload');
  }
  if (!payload?.gymId || !payload.platform || !payload.platformUserId || !payload.exp) {
    throw new ValidationError('Invalid OAuth state fields');
  }
  if (!isMarketingSocialPlatform(payload.platform)) {
    throw new ValidationError('Unsupported OAuth platform in state');
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new ValidationError('OAuth state expired; start connect again');
  }
  return payload;
}
