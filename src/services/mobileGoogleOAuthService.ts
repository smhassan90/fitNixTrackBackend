import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AppError, GoneError, NotFoundError } from '../utils/errors';
import { verifyGoogleIdToken } from './mobileGoogleAuthService';

const SESSION_TTL_SECONDS = 300;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  appScheme: string;
};

function getOAuthConfig(): OAuthConfig {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  const appScheme = process.env.MOBILE_APP_OAUTH_SCHEME?.trim() || 'fitnixtrackapp';

  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(
      'OAUTH_MISCONFIGURED',
      'Google OAuth is not configured. Set GOOGLE_WEB_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.',
      500
    );
  }

  return { clientId, clientSecret, redirectUri, appScheme };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function generateCodeVerifier(): string {
  return base64Url(crypto.randomBytes(32));
}

function codeChallengeFromVerifier(verifier: string): string {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

function buildDeepLink(scheme: string, params: Record<string, string>): string {
  return `${scheme}://oauth?${new URLSearchParams(params).toString()}`;
}

async function purgeExpiredOAuthSessions(): Promise<void> {
  await prisma.mobileOAuthSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}

async function exchangeCodeForIdToken(
  code: string,
  config: OAuthConfig,
  codeVerifier: string
): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = (await response.json()) as { id_token?: string; error?: string };

  if (!response.ok || !payload.id_token) {
    throw new AppError(
      'OAUTH_TOKEN_EXCHANGE_FAILED',
      payload.error ?? 'Failed to exchange authorization code',
      502
    );
  }

  return payload.id_token;
}

export async function startMobileGoogleOAuth(platform?: string) {
  const config = getOAuthConfig();
  await purgeExpiredOAuthSessions();

  const sessionId = crypto.randomUUID();
  const state = base64Url(crypto.randomBytes(32));
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeFromVerifier(codeVerifier);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await prisma.mobileOAuthSession.create({
    data: {
      sessionId,
      state,
      codeVerifier,
      expiresAt,
      platform: platform?.trim() || null,
    },
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });

  return {
    authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    sessionId,
    expiresInSeconds: SESSION_TTL_SECONDS,
  };
}

export async function handleGoogleOAuthCallback(query: {
  code?: string;
  state?: string;
  error?: string;
}): Promise<string> {
  let appScheme = 'fitnixtrackapp';
  try {
    appScheme = getOAuthConfig().appScheme;
  } catch {
    return buildDeepLink(appScheme, { error: 'oauth_failed' });
  }

  if (query.error) {
    const errorCode = query.error === 'access_denied' ? 'access_denied' : 'oauth_failed';
    return buildDeepLink(appScheme, { error: errorCode });
  }

  if (!query.code || !query.state) {
    return buildDeepLink(appScheme, { error: 'oauth_failed' });
  }

  const session = await prisma.mobileOAuthSession.findUnique({
    where: { state: query.state },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.mobileOAuthSession.delete({ where: { sessionId: session.sessionId } });
    }
    return buildDeepLink(appScheme, { error: 'session_expired' });
  }

  if (session.used || session.idToken) {
    return buildDeepLink(appScheme, { error: 'oauth_failed' });
  }

  try {
    const config = getOAuthConfig();
    const idToken = await exchangeCodeForIdToken(query.code, config, session.codeVerifier);
    await verifyGoogleIdToken(idToken);

    await prisma.mobileOAuthSession.update({
      where: { sessionId: session.sessionId },
      data: { idToken },
    });

    return buildDeepLink(appScheme, { sessionId: session.sessionId });
  } catch {
    return buildDeepLink(appScheme, { error: 'oauth_failed' });
  }
}

export async function completeMobileGoogleOAuth(sessionId: string): Promise<{ idToken: string }> {
  await purgeExpiredOAuthSessions();

  const session = await prisma.mobileOAuthSession.findUnique({
    where: { sessionId },
  });

  if (!session) {
    throw new NotFoundError('OAuth session', sessionId);
  }

  if (session.expiresAt < new Date()) {
    await prisma.mobileOAuthSession.delete({ where: { sessionId } });
    throw new GoneError('OAuth session expired');
  }

  if (session.used) {
    throw new GoneError('OAuth session already consumed');
  }

  if (!session.idToken) {
    throw new GoneError('OAuth session not ready — complete Google sign-in in the browser first');
  }

  const idToken = session.idToken;

  await prisma.mobileOAuthSession.delete({ where: { sessionId } });

  return { idToken };
}
