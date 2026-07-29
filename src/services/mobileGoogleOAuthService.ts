import crypto from 'crypto';
import { Prisma } from '@prisma/client';
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

type OAuthStartConfig = Pick<OAuthConfig, 'clientId' | 'redirectUri' | 'appScheme'>;

function getOAuthStartConfig(): OAuthStartConfig {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID?.trim();
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  const appScheme = process.env.MOBILE_APP_OAUTH_SCHEME?.trim() || 'fitnixtrackapp';

  if (!clientId || !redirectUri) {
    throw new AppError(
      'OAUTH_BACKEND_MISCONFIGURED',
      'Google OAuth is not configured. Set GOOGLE_WEB_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI.',
      500
    );
  }

  return { clientId, redirectUri, appScheme };
}

function getOAuthCallbackConfig(): OAuthConfig {
  const start = getOAuthStartConfig();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientSecret) {
    throw new AppError(
      'OAUTH_BACKEND_MISCONFIGURED',
      'Google OAuth is not configured. Set GOOGLE_CLIENT_SECRET.',
      500
    );
  }

  return { ...start, clientSecret };
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

function mapSessionStoreError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2021' || error.code === 'P2022')
  ) {
    throw new AppError(
      'OAUTH_BACKEND_MISCONFIGURED',
      'OAuth session storage is not ready. Run database migrations for mobile_oauth_sessions.',
      500
    );
  }
  throw error;
}

async function purgeExpiredOAuthSessions(): Promise<void> {
  try {
    await prisma.mobileOAuthSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  } catch (error) {
    mapSessionStoreError(error);
  }
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
  const config = getOAuthStartConfig();
  await purgeExpiredOAuthSessions();

  const sessionId = crypto.randomUUID();
  const state = base64Url(crypto.randomBytes(32));
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeFromVerifier(codeVerifier);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  try {
    await prisma.mobileOAuthSession.create({
      data: {
        sessionId,
        state,
        codeVerifier,
        expiresAt,
        platform: platform?.trim() || null,
      },
    });
  } catch (error) {
    mapSessionStoreError(error);
  }

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
    appScheme = getOAuthStartConfig().appScheme;
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

  let session;
  try {
    session = await prisma.mobileOAuthSession.findUnique({
      where: { state: query.state },
    });
  } catch (error) {
    mapSessionStoreError(error);
  }

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      try {
        await prisma.mobileOAuthSession.delete({ where: { sessionId: session.sessionId } });
      } catch (error) {
        mapSessionStoreError(error);
      }
    }
    return buildDeepLink(appScheme, { error: 'session_expired' });
  }

  if (session.used || session.idToken) {
    return buildDeepLink(appScheme, { error: 'oauth_failed' });
  }

  try {
    const config = getOAuthCallbackConfig();
    const idToken = await exchangeCodeForIdToken(query.code, config, session.codeVerifier);
    await verifyGoogleIdToken(idToken);

    try {
      await prisma.mobileOAuthSession.update({
        where: { sessionId: session.sessionId },
        data: { idToken },
      });
    } catch (error) {
      mapSessionStoreError(error);
    }

    return buildDeepLink(appScheme, { sessionId: session.sessionId });
  } catch (error) {
    console.error('[mobile-google-oauth] callback exchange failed', {
      statePresent: Boolean(query.state),
      codePresent: Boolean(query.code),
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return buildDeepLink(appScheme, { error: 'oauth_failed' });
  }
}

export async function completeMobileGoogleOAuth(sessionId: string): Promise<{ idToken: string }> {
  await purgeExpiredOAuthSessions();

  let session;
  try {
    session = await prisma.mobileOAuthSession.findUnique({
      where: { sessionId },
    });
  } catch (error) {
    mapSessionStoreError(error);
  }

  if (!session) {
    throw new NotFoundError('OAuth session', sessionId);
  }

  if (session.expiresAt < new Date()) {
    try {
      await prisma.mobileOAuthSession.delete({ where: { sessionId } });
    } catch (error) {
      mapSessionStoreError(error);
    }
    throw new GoneError('OAuth session expired');
  }

  if (session.used) {
    throw new GoneError('OAuth session already consumed');
  }

  if (!session.idToken) {
    throw new GoneError('OAuth session not ready — complete Google sign-in in the browser first');
  }

  const idToken = session.idToken;

  try {
    await prisma.mobileOAuthSession.delete({ where: { sessionId } });
  } catch (error) {
    mapSessionStoreError(error);
  }

  return { idToken };
}
