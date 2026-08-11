import { AppError } from '../../../utils/errors';
import {
  ConnectableSocialAccount,
  MarketingSocialOAuthProvider,
  OAuthAppRuntimeConfig,
  OAuthTokenSet,
} from './types';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graphGet<T>(
  path: string,
  accessToken: string,
  query: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  url.searchParams.set('access_token', accessToken);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok || (json as { error?: { message?: string } }).error) {
    throw new AppError(
      'OAUTH_PROVIDER_ERROR',
      (json as { error?: { message?: string } }).error?.message ||
        `Facebook Graph error (${res.status})`,
      502
    );
  }
  return json;
}

async function exchangeLongLivedUserToken(
  shortToken: string,
  config: OAuthAppRuntimeConfig
): Promise<OAuthTokenSet> {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('client_secret', config.clientSecret);
  url.searchParams.set('fb_exchange_token', shortToken);
  const res = await fetch(url.toString());
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  };
  if (!res.ok || !json.access_token) {
    throw new AppError(
      'OAUTH_TOKEN_EXCHANGE_FAILED',
      json.error?.message || 'Failed to exchange Facebook long-lived token',
      502
    );
  }
  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
  };
}

type PageNode = {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string };
};

async function listFacebookPages(userToken: string): Promise<PageNode[]> {
  const pages: PageNode[] = [];
  let next: string | null = `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100&access_token=${encodeURIComponent(userToken)}`;
  while (next) {
    const res = await fetch(next);
    const json = (await res.json()) as {
      data?: PageNode[];
      paging?: { next?: string };
      error?: { message?: string };
    };
    if (!res.ok || json.error) {
      throw new AppError(
        'OAUTH_PROVIDER_ERROR',
        json.error?.message || 'Failed to list Facebook Pages',
        502
      );
    }
    pages.push(...(json.data || []));
    next = json.paging?.next || null;
  }
  return pages;
}

function createMetaProvider(
  platform: 'facebook' | 'instagram',
  scopes: string[]
): MarketingSocialOAuthProvider {
  return {
    platform,
    getAuthorizeUrl(state: string, config: OAuthAppRuntimeConfig) {
      const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', scopes.join(','));
      return url.toString();
    },
    async exchangeCode(code: string, config: OAuthAppRuntimeConfig) {
      const url = new URL(`${GRAPH}/oauth/access_token`);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('client_secret', config.clientSecret);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('code', code);
      const res = await fetch(url.toString());
      const json = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
        error?: { message?: string };
      };
      if (!res.ok || !json.access_token) {
        throw new AppError(
          'OAUTH_TOKEN_EXCHANGE_FAILED',
          json.error?.message || 'Facebook code exchange failed',
          502
        );
      }
      return exchangeLongLivedUserToken(json.access_token, config);
    },
    async listConnectableAccounts(tokens: OAuthTokenSet) {
      const pages = await listFacebookPages(tokens.accessToken);
      const out: ConnectableSocialAccount[] = [];

      if (platform === 'facebook') {
        for (const page of pages) {
          if (!page.id || !page.access_token) continue;
          out.push({
            platform: 'facebook',
            externalAccountId: page.id,
            accountName: page.name || `Facebook Page ${page.id}`,
            accessToken: page.access_token,
            expiresAt: tokens.expiresAt ?? null,
            metadata: {
              pageId: page.id,
              hasInstagram: Boolean(page.instagram_business_account?.id),
            },
          });
        }
      } else {
        for (const page of pages) {
          const igId = page.instagram_business_account?.id;
          if (!igId || !page.access_token) continue;
          let igName = `Instagram ${igId}`;
          try {
            const ig = await graphGet<{ username?: string; name?: string }>(
              `/${igId}`,
              page.access_token,
              { fields: 'username,name' }
            );
            igName = ig.username || ig.name || igName;
          } catch {
            // keep fallback name
          }
          out.push({
            platform: 'instagram',
            externalAccountId: igId,
            accountName: igName,
            accessToken: page.access_token,
            expiresAt: tokens.expiresAt ?? null,
            metadata: {
              igBusinessAccountId: igId,
              facebookPageId: page.id,
              facebookPageName: page.name || null,
            },
          });
        }
      }

      return out;
    },
  };
}

export const facebookProvider = createMetaProvider('facebook', [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
]);

export const instagramProvider = createMetaProvider('instagram', [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
]);
