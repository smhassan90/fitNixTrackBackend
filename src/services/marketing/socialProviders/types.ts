/**
 * Marketing social OAuth provider contract.
 * App credentials come from MarketingPlatformSettings (DB), not process.env.
 */

export const MARKETING_SOCIAL_PLATFORMS = [
  'facebook',
  'instagram',
  'linkedin',
  'google_business',
] as const;

export const MARKETING_SOCIAL_PLATFORMS_FUTURE = [
  'tiktok',
  'youtube',
  'pinterest',
] as const;

export type MarketingSocialPlatform = (typeof MARKETING_SOCIAL_PLATFORMS)[number];

export type OAuthAppRuntimeConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  tokenType?: string | null;
  scope?: string | null;
};

export type ConnectableSocialAccount = {
  platform: MarketingSocialPlatform;
  externalAccountId: string;
  accountName: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
};

export interface MarketingSocialOAuthProvider {
  readonly platform: MarketingSocialPlatform;

  getAuthorizeUrl(state: string, config: OAuthAppRuntimeConfig): string;

  exchangeCode(code: string, config: OAuthAppRuntimeConfig): Promise<OAuthTokenSet>;

  listConnectableAccounts(tokens: OAuthTokenSet): Promise<ConnectableSocialAccount[]>;
}

export function isMarketingSocialPlatform(value: string): value is MarketingSocialPlatform {
  return (MARKETING_SOCIAL_PLATFORMS as readonly string[]).includes(value);
}
