import { AppError } from '../../../utils/errors';
import {
  ConnectableSocialAccount,
  MarketingSocialOAuthProvider,
  OAuthAppRuntimeConfig,
  OAuthTokenSet,
} from './types';

export const googleBusinessProvider: MarketingSocialOAuthProvider = {
  platform: 'google_business',

  getAuthorizeUrl(state: string, config: OAuthAppRuntimeConfig) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    url.searchParams.set(
      'scope',
      ['openid', 'email', 'https://www.googleapis.com/auth/business.manage'].join(' ')
    );
    return url.toString();
  },

  async exchangeCode(code: string, config: OAuthAppRuntimeConfig): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new AppError(
        'OAUTH_TOKEN_EXCHANGE_FAILED',
        json.error_description || json.error || 'Google token exchange failed',
        502
      );
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    };
  },

  async listConnectableAccounts(tokens: OAuthTokenSet): Promise<ConnectableSocialAccount[]> {
    const accountsRes = await fetch(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    const accountsJson = (await accountsRes.json()) as {
      accounts?: Array<{ name?: string; accountName?: string }>;
      error?: { message?: string };
    };
    if (!accountsRes.ok) {
      throw new AppError(
        'OAUTH_PROVIDER_ERROR',
        accountsJson.error?.message ||
          `Google Business accounts failed (${accountsRes.status})`,
        502
      );
    }

    const out: ConnectableSocialAccount[] = [];
    for (const account of accountsJson.accounts || []) {
      const accountResource = account.name;
      if (!accountResource) continue;

      const locRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${accountResource}/locations?readMask=name,title,storefrontAddress`,
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
      );
      const locJson = (await locRes.json()) as {
        locations?: Array<{ name?: string; title?: string }>;
        error?: { message?: string };
      };
      if (!locRes.ok) {
        out.push({
          platform: 'google_business',
          externalAccountId: accountResource,
          accountName: account.accountName || accountResource,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
          metadata: { accountResource, level: 'account' },
        });
        continue;
      }

      for (const loc of locJson.locations || []) {
        if (!loc.name) continue;
        out.push({
          platform: 'google_business',
          externalAccountId: loc.name,
          accountName: loc.title || loc.name,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
          metadata: {
            accountResource,
            locationResource: loc.name,
            level: 'location',
          },
        });
      }
    }

    return out;
  },
};
