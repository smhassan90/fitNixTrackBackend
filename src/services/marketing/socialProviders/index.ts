import { ValidationError } from '../../../utils/errors';
import { facebookProvider, instagramProvider } from './facebookProvider';
import { linkedinProvider } from './linkedinProvider';
import { googleBusinessProvider } from './googleBusinessProvider';
import {
  isMarketingSocialPlatform,
  MarketingSocialOAuthProvider,
  MarketingSocialPlatform,
  MARKETING_SOCIAL_PLATFORMS,
} from './types';

const registry: Record<MarketingSocialPlatform, MarketingSocialOAuthProvider> = {
  facebook: facebookProvider,
  instagram: instagramProvider,
  linkedin: linkedinProvider,
  google_business: googleBusinessProvider,
};

export function getSocialOAuthProvider(platform: string): MarketingSocialOAuthProvider {
  if (!isMarketingSocialPlatform(platform)) {
    throw new ValidationError(
      `Unsupported platform '${platform}'. Supported: ${MARKETING_SOCIAL_PLATFORMS.join(', ')}`
    );
  }
  return registry[platform];
}

export function listSocialOAuthProviders(): MarketingSocialOAuthProvider[] {
  return MARKETING_SOCIAL_PLATFORMS.map((p) => registry[p]);
}

export { MARKETING_SOCIAL_PLATFORMS, isMarketingSocialPlatform };
export type { MarketingSocialPlatform, MarketingSocialOAuthProvider };
