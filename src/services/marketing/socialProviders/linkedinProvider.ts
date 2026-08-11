import { AppError } from '../../../utils/errors';
import {
  ConnectableSocialAccount,
  MarketingSocialOAuthProvider,
  OAuthAppRuntimeConfig,
  OAuthTokenSet,
} from './types';

export const linkedinProvider: MarketingSocialOAuthProvider = {
  platform: 'linkedin',

  getAuthorizeUrl(state: string, config: OAuthAppRuntimeConfig) {
    const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set(
      'scope',
      [
        'openid',
        'profile',
        'r_organization_social',
        'w_organization_social',
        'rw_organization_admin',
      ].join(' ')
    );
    return url.toString();
  },

  async exchangeCode(code: string, config: OAuthAppRuntimeConfig): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
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
        json.error_description || json.error || 'LinkedIn code exchange failed',
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
    const res = await fetch(
      'https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organizationalTarget~(id,localizedName)))',
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );
    const json = (await res.json()) as {
      elements?: Array<{
        ['organizationalTarget~']?: { id?: number | string; localizedName?: string };
        organizationalTarget?: string;
      }>;
      message?: string;
    };
    if (!res.ok) {
      throw new AppError(
        'OAUTH_PROVIDER_ERROR',
        json.message || `LinkedIn org lookup failed (${res.status})`,
        502
      );
    }

    const out: ConnectableSocialAccount[] = [];
    for (const el of json.elements || []) {
      const org = el['organizationalTarget~'];
      const id =
        org?.id != null
          ? String(org.id)
          : el.organizationalTarget?.replace('urn:li:organization:', '');
      if (!id) continue;
      out.push({
        platform: 'linkedin',
        externalAccountId: id,
        accountName: org?.localizedName || `LinkedIn Org ${id}`,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt ?? null,
        metadata: {
          organizationUrn: `urn:li:organization:${id}`,
        },
      });
    }
    return out;
  },
};
