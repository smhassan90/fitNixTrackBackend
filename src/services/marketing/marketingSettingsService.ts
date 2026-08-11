import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import {
  decryptSecret,
  encryptSecret,
  secretHint,
} from './marketingTokenCrypto';
import {
  MARKETING_SOCIAL_PLATFORMS,
  MarketingSocialPlatform,
} from './socialProviders/types';

export type OAuthAppStored = {
  platform: MarketingSocialPlatform | string;
  clientId: string | null;
  clientSecretEnc: string | null;
  redirectUri: string | null;
  enabled: boolean;
  notes: string | null;
};

export type MarketingSettingsRow = {
  id: number;
  portalReturnBaseUrl: string | null;
  aiEnabled: boolean;
  aiProvider: string;
  aiTextModel: string | null;
  aiImageModel: string | null;
  aiBaseUrl: string | null;
  aiApiKeyEnc: string | null;
  oauthApps: OAuthAppStored[];
  updatedAt: Date;
};

export type SecretStatus = {
  configured: boolean;
  hint: string | null;
};

export type MarketingSettingsPublicDto = {
  portalReturnBaseUrl: string | null;
  ai: {
    provider: string;
    textModel: string | null;
    imageModel: string | null;
    baseUrl: string | null;
    enabled: boolean;
    apiKey: SecretStatus;
  };
  oauthApps: Array<{
    platform: string;
    clientId: string | null;
    redirectUri: string | null;
    enabled: boolean;
    notes: string | null;
    clientSecret: SecretStatus;
  }>;
  updatedAt: string;
};

export type MarketingSettingsUpdateInput = {
  portalReturnBaseUrl?: string | null;
  ai?: {
    provider?: string;
    textModel?: string | null;
    imageModel?: string | null;
    baseUrl?: string | null;
    enabled?: boolean;
    apiKey?: string | null;
  };
  oauthApps?: Array<{
    platform: string;
    clientId?: string | null;
    redirectUri?: string | null;
    enabled?: boolean;
    notes?: string | null;
    clientSecret?: string | null;
  }>;
};

const CACHE_TTL_MS = 15_000;
let cache: { at: number; row: MarketingSettingsRow } | null = null;

function defaultOAuthApps(): OAuthAppStored[] {
  return MARKETING_SOCIAL_PLATFORMS.map((platform) => ({
    platform,
    clientId: null,
    clientSecretEnc: null,
    redirectUri: null,
    enabled: false,
    notes: null,
  }));
}

function parseOAuthApps(raw: Prisma.JsonValue | null | undefined): OAuthAppStored[] {
  const defaults = defaultOAuthApps();
  if (!Array.isArray(raw)) return defaults;
  const byPlatform = new Map<string, OAuthAppStored>();
  for (const d of defaults) byPlatform.set(d.platform, { ...d });
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const platform = typeof o.platform === 'string' ? o.platform : null;
    if (!platform) continue;
    byPlatform.set(platform, {
      platform,
      clientId: typeof o.clientId === 'string' ? o.clientId : null,
      clientSecretEnc: typeof o.clientSecretEnc === 'string' ? o.clientSecretEnc : null,
      redirectUri: typeof o.redirectUri === 'string' ? o.redirectUri : null,
      enabled: o.enabled === true,
      notes: typeof o.notes === 'string' ? o.notes : null,
    });
  }
  // Keep known platforms first, then any extras
  const known = MARKETING_SOCIAL_PLATFORMS.map((p) => byPlatform.get(p)!);
  const extras = [...byPlatform.values()].filter(
    (a) => !(MARKETING_SOCIAL_PLATFORMS as readonly string[]).includes(a.platform)
  );
  return [...known, ...extras];
}

function mapRow(row: {
  id: number;
  portalReturnBaseUrl: string | null;
  aiEnabled: boolean;
  aiProvider: string;
  aiTextModel: string | null;
  aiImageModel: string | null;
  aiBaseUrl: string | null;
  aiApiKeyEnc: string | null;
  oauthApps: Prisma.JsonValue | null;
  updatedAt: Date;
}): MarketingSettingsRow {
  return {
    id: row.id,
    portalReturnBaseUrl: row.portalReturnBaseUrl,
    aiEnabled: row.aiEnabled,
    aiProvider: row.aiProvider,
    aiTextModel: row.aiTextModel,
    aiImageModel: row.aiImageModel,
    aiBaseUrl: row.aiBaseUrl,
    aiApiKeyEnc: row.aiApiKeyEnc,
    oauthApps: parseOAuthApps(row.oauthApps),
    updatedAt: row.updatedAt,
  };
}

export function invalidateMarketingSettingsCache(): void {
  cache = null;
}

export async function ensureMarketingSettings(): Promise<MarketingSettingsRow> {
  let row = await prisma.marketingPlatformSettings.findUnique({ where: { id: 1 } });
  if (!row) {
    row = await prisma.marketingPlatformSettings.create({
      data: {
        id: 1,
        aiEnabled: false,
        aiProvider: 'openai',
        oauthApps: defaultOAuthApps() as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return mapRow(row);
}

export async function getMarketingSettingsCached(): Promise<MarketingSettingsRow> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.row;
  }
  const row = await ensureMarketingSettings();
  cache = { at: now, row };
  return row;
}

function hintFromEnc(enc: string | null | undefined): SecretStatus {
  if (!enc) return { configured: false, hint: null };
  try {
    const plain = decryptSecret(enc);
    return { configured: true, hint: secretHint(plain) };
  } catch {
    return { configured: true, hint: '••••' };
  }
}

export function toPublicSettingsDto(row: MarketingSettingsRow): MarketingSettingsPublicDto {
  return {
    portalReturnBaseUrl: row.portalReturnBaseUrl,
    ai: {
      provider: row.aiProvider,
      textModel: row.aiTextModel,
      imageModel: row.aiImageModel,
      baseUrl: row.aiBaseUrl,
      enabled: row.aiEnabled,
      apiKey: hintFromEnc(row.aiApiKeyEnc),
    },
    oauthApps: row.oauthApps.map((app) => ({
      platform: app.platform,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      enabled: app.enabled,
      notes: app.notes,
      clientSecret: hintFromEnc(app.clientSecretEnc),
    })),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getMarketingSettingsPublic(): Promise<MarketingSettingsPublicDto> {
  const row = await getMarketingSettingsCached();
  return toPublicSettingsDto(row);
}

export async function updateMarketingSettings(params: {
  patch: MarketingSettingsUpdateInput;
  actorUserId: number;
  actorRole: string;
}): Promise<MarketingSettingsPublicDto> {
  const existing = await ensureMarketingSettings();
  const changedKeys: string[] = [];

  let portalReturnBaseUrl = existing.portalReturnBaseUrl;
  if ('portalReturnBaseUrl' in (params.patch || {})) {
    const next = params.patch.portalReturnBaseUrl;
    portalReturnBaseUrl =
      next === undefined ? existing.portalReturnBaseUrl : next?.trim() || null;
    if (portalReturnBaseUrl !== existing.portalReturnBaseUrl) {
      changedKeys.push('portalReturnBaseUrl');
    }
  }

  let aiEnabled = existing.aiEnabled;
  let aiProvider = existing.aiProvider;
  let aiTextModel = existing.aiTextModel;
  let aiImageModel = existing.aiImageModel;
  let aiBaseUrl = existing.aiBaseUrl;
  let aiApiKeyEnc = existing.aiApiKeyEnc;

  if (params.patch.ai) {
    const ai = params.patch.ai;
    if (ai.enabled !== undefined && ai.enabled !== existing.aiEnabled) {
      aiEnabled = ai.enabled;
      changedKeys.push('ai.enabled');
    }
    if (ai.provider !== undefined) {
      const p = ai.provider.trim().toLowerCase() || 'openai';
      if (p !== existing.aiProvider) {
        aiProvider = p;
        changedKeys.push('ai.provider');
      }
    }
    if ('textModel' in ai) {
      const v = ai.textModel?.trim() || null;
      if (v !== existing.aiTextModel) {
        aiTextModel = v;
        changedKeys.push('ai.textModel');
      }
    }
    if ('imageModel' in ai) {
      const v = ai.imageModel?.trim() || null;
      if (v !== existing.aiImageModel) {
        aiImageModel = v;
        changedKeys.push('ai.imageModel');
      }
    }
    if ('baseUrl' in ai) {
      const v = ai.baseUrl?.trim() || null;
      if (v !== existing.aiBaseUrl) {
        aiBaseUrl = v;
        changedKeys.push('ai.baseUrl');
      }
    }
    if (typeof ai.apiKey === 'string' && ai.apiKey.trim()) {
      aiApiKeyEnc = encryptSecret(ai.apiKey.trim());
      changedKeys.push('ai.apiKey');
    }
  }

  const oauthApps = existing.oauthApps.map((a) => ({ ...a }));
  if (params.patch.oauthApps) {
    for (const patchApp of params.patch.oauthApps) {
      const idx = oauthApps.findIndex((a) => a.platform === patchApp.platform);
      if (idx < 0) {
        throw new ValidationError(`Unknown OAuth platform: ${patchApp.platform}`);
      }
      const cur = oauthApps[idx];
      if ('clientId' in patchApp) {
        const v = patchApp.clientId?.trim() || null;
        if (v !== cur.clientId) {
          cur.clientId = v;
          changedKeys.push(`oauth.${cur.platform}.clientId`);
        }
      }
      if ('redirectUri' in patchApp) {
        const v = patchApp.redirectUri?.trim() || null;
        if (v !== cur.redirectUri) {
          cur.redirectUri = v;
          changedKeys.push(`oauth.${cur.platform}.redirectUri`);
        }
      }
      if (patchApp.enabled !== undefined && patchApp.enabled !== cur.enabled) {
        cur.enabled = patchApp.enabled;
        changedKeys.push(`oauth.${cur.platform}.enabled`);
      }
      if ('notes' in patchApp) {
        const v = patchApp.notes?.trim() || null;
        if (v !== cur.notes) {
          cur.notes = v;
          changedKeys.push(`oauth.${cur.platform}.notes`);
        }
      }
      if (typeof patchApp.clientSecret === 'string' && patchApp.clientSecret.trim()) {
        cur.clientSecretEnc = encryptSecret(patchApp.clientSecret.trim());
        changedKeys.push(`oauth.${cur.platform}.clientSecret`);
      }
      oauthApps[idx] = cur;
    }
  }

  const updated = await prisma.marketingPlatformSettings.update({
    where: { id: 1 },
    data: {
      portalReturnBaseUrl,
      aiEnabled,
      aiProvider,
      aiTextModel,
      aiImageModel,
      aiBaseUrl,
      aiApiKeyEnc,
      oauthApps: oauthApps as unknown as Prisma.InputJsonValue,
    },
  });

  invalidateMarketingSettingsCache();

  if (changedKeys.length > 0) {
    await writePlatformAuditLog({
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      actionType: 'MARKETING_SETTINGS_UPDATE',
      metadata: { changedFields: changedKeys },
    });
  }

  return toPublicSettingsDto(mapRow(updated));
}

export type RuntimeAiConfig = {
  provider: string;
  textModel: string;
  imageModel: string;
  baseUrl: string | null;
  apiKey: string;
};

export async function requireRuntimeAiConfig(kind: 'text' | 'image'): Promise<RuntimeAiConfig> {
  const row = await getMarketingSettingsCached();
  if (!row.aiEnabled) {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  if (!row.aiApiKeyEnc) {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(row.aiApiKeyEnc);
  } catch {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  if (!apiKey) {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  const provider = (row.aiProvider || 'openai').toLowerCase();
  if (provider !== 'openai') {
    throw new ValidationError(`Unsupported AI provider: ${provider}`);
  }
  const textModel = row.aiTextModel?.trim() || 'gpt-4o-mini';
  const imageModel = row.aiImageModel?.trim() || 'dall-e-3';
  return {
    provider,
    textModel,
    imageModel,
    baseUrl: row.aiBaseUrl?.trim() || null,
    apiKey,
  };
}

export type RuntimeOAuthAppConfig = {
  platform: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  enabled: boolean;
};

export async function requireRuntimeOAuthApp(
  platform: string
): Promise<RuntimeOAuthAppConfig> {
  const row = await getMarketingSettingsCached();
  const app = row.oauthApps.find((a) => a.platform === platform);
  if (!app || !app.enabled || !app.clientId?.trim() || !app.redirectUri?.trim() || !app.clientSecretEnc) {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  let clientSecret: string;
  try {
    clientSecret = decryptSecret(app.clientSecretEnc);
  } catch {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  if (!clientSecret) {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  return {
    platform: app.platform,
    clientId: app.clientId.trim(),
    clientSecret,
    redirectUri: app.redirectUri.trim(),
    enabled: true,
  };
}

export async function getPortalReturnBaseUrl(): Promise<string> {
  const row = await getMarketingSettingsCached();
  const url = row.portalReturnBaseUrl?.trim();
  if (!url) {
    throw new ValidationError('Configure this integration in Marketing settings');
  }
  return url.replace(/\/$/, '');
}

export async function listOAuthAppPublicStatus(): Promise<
  Array<{ platform: string; configured: boolean; enabled: boolean }>
> {
  const row = await getMarketingSettingsCached();
  return row.oauthApps.map((app) => ({
    platform: app.platform,
    enabled: app.enabled,
    configured: Boolean(
      app.enabled && app.clientId && app.redirectUri && app.clientSecretEnc
    ),
  }));
}
