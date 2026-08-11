import { getPortalReturnBaseUrl } from '../marketingSettingsService';

export async function buildPortalSocialRedirect(params: {
  gymId: number;
  platform: string;
  ok: boolean;
  message?: string;
  connectedCount?: number;
}): Promise<string> {
  const base = await getPortalReturnBaseUrl();
  const q = new URLSearchParams();
  if (params.ok) {
    q.set('oauth', 'success');
    q.set('platform', params.platform);
    if (params.connectedCount != null) {
      q.set('connected', String(params.connectedCount));
    }
  } else {
    q.set('oauth', 'error');
    q.set('platform', params.platform);
    q.set('message', (params.message || 'OAuth failed').slice(0, 300));
  }
  return `${base}/platform/marketing/${params.gymId}/social?${q.toString()}`;
}

export async function buildPortalMarketingErrorRedirect(params: {
  platform: string;
  message: string;
}): Promise<string> {
  const base = await getPortalReturnBaseUrl();
  const q = new URLSearchParams({
    oauth: 'error',
    platform: params.platform,
    message: params.message.slice(0, 300),
  });
  return `${base}/platform/marketing?${q.toString()}`;
}
