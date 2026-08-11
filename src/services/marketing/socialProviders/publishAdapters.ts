import { AppError } from '../../../utils/errors';

export type PublishPayload = {
  caption: string;
  imageUrl?: string | null;
  externalAccountId: string;
  accessToken: string;
  metadata?: Record<string, unknown> | null;
};

export type PublishResult = {
  externalId: string | null;
};

const GRAPH = 'https://graph.facebook.com/v21.0';

export async function publishToFacebook(payload: PublishPayload): Promise<PublishResult> {
  const pageId = payload.externalAccountId;
  if (payload.imageUrl) {
    const url = new URL(`${GRAPH}/${pageId}/photos`);
    const body = new URLSearchParams({
      url: payload.imageUrl,
      caption: payload.caption,
      access_token: payload.accessToken,
    });
    const res = await fetch(url.toString(), { method: 'POST', body });
    const json = (await res.json()) as { id?: string; post_id?: string; error?: { message?: string } };
    if (!res.ok || json.error) {
      throw new AppError('PUBLISH_FAILED', json.error?.message || 'Facebook photo publish failed', 502);
    }
    return { externalId: json.post_id || json.id || null };
  }
  const url = new URL(`${GRAPH}/${pageId}/feed`);
  const body = new URLSearchParams({
    message: payload.caption,
    access_token: payload.accessToken,
  });
  const res = await fetch(url.toString(), { method: 'POST', body });
  const json = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || json.error) {
    throw new AppError('PUBLISH_FAILED', json.error?.message || 'Facebook feed publish failed', 502);
  }
  return { externalId: json.id || null };
}

export async function publishToInstagram(payload: PublishPayload): Promise<PublishResult> {
  const igUserId = payload.externalAccountId;
  if (!payload.imageUrl) {
    throw new AppError('PUBLISH_FAILED', 'Instagram publish requires an approved image URL', 400);
  }
  const createUrl = new URL(`${GRAPH}/${igUserId}/media`);
  const createBody = new URLSearchParams({
    image_url: payload.imageUrl,
    caption: payload.caption,
    access_token: payload.accessToken,
  });
  const createRes = await fetch(createUrl.toString(), { method: 'POST', body: createBody });
  const createJson = (await createRes.json()) as { id?: string; error?: { message?: string } };
  if (!createRes.ok || !createJson.id) {
    throw new AppError(
      'PUBLISH_FAILED',
      createJson.error?.message || 'Instagram media container failed',
      502
    );
  }
  const publishUrl = new URL(`${GRAPH}/${igUserId}/media_publish`);
  const publishBody = new URLSearchParams({
    creation_id: createJson.id,
    access_token: payload.accessToken,
  });
  const pubRes = await fetch(publishUrl.toString(), { method: 'POST', body: publishBody });
  const pubJson = (await pubRes.json()) as { id?: string; error?: { message?: string } };
  if (!pubRes.ok || pubJson.error) {
    throw new AppError('PUBLISH_FAILED', pubJson.error?.message || 'Instagram publish failed', 502);
  }
  return { externalId: pubJson.id || createJson.id };
}

export async function publishToLinkedIn(payload: PublishPayload): Promise<PublishResult> {
  const orgId = payload.externalAccountId;
  const author = `urn:li:organization:${orgId}`;
  const body: Record<string, unknown> = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: payload.caption },
        shareMediaCategory: payload.imageUrl ? 'IMAGE' : 'NONE',
        ...(payload.imageUrl
          ? {
              media: [
                {
                  status: 'READY',
                  originalUrl: payload.imageUrl,
                },
              ],
            }
          : {}),
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AppError('PUBLISH_FAILED', text.slice(0, 500) || 'LinkedIn publish failed', 502);
  }
  const id = res.headers.get('x-restli-id') || null;
  return { externalId: id };
}

export async function publishToGoogleBusiness(payload: PublishPayload): Promise<PublishResult> {
  // location resource name is externalAccountId (locations/...)
  const locationName = payload.externalAccountId;
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/localPosts`;
  const body = {
    languageCode: 'en',
    summary: payload.caption.slice(0, 1500),
    topicType: 'STANDARD',
    ...(payload.imageUrl
      ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: payload.imageUrl }] }
      : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { name?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new AppError(
      'PUBLISH_FAILED',
      json.error?.message || `Google Business publish failed (${res.status})`,
      502
    );
  }
  return { externalId: json.name || null };
}

export async function publishViaPlatform(
  platform: string,
  payload: PublishPayload
): Promise<PublishResult> {
  switch (platform) {
    case 'facebook':
      return publishToFacebook(payload);
    case 'instagram':
      return publishToInstagram(payload);
    case 'linkedin':
      return publishToLinkedIn(payload);
    case 'google_business':
      return publishToGoogleBusiness(payload);
    default:
      throw new AppError('PUBLISH_FAILED', `Unsupported publish platform: ${platform}`, 400);
  }
}
