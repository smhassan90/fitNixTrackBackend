import { MarketingSocialAccount, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { writePlatformAuditLog } from '../platformAuditService';
import { encryptSecret } from './marketingTokenCrypto';
import {
  getSocialOAuthProvider,
  MarketingSocialPlatform,
  MARKETING_SOCIAL_PLATFORMS,
} from './socialProviders';
import { signMarketingOAuthState, verifyMarketingOAuthState } from './socialProviders/oauthState';
import {
  buildPortalMarketingErrorRedirect,
  buildPortalSocialRedirect,
} from './socialProviders/oauthUrls';
import {
  listOAuthAppPublicStatus,
  requireRuntimeOAuthApp,
} from './marketingSettingsService';

export type SocialAccountDto = {
  id: number;
  gymId: number;
  platform: string;
  accountName: string | null;
  externalAccountId: string | null;
  status: string;
  connectedAt: string | null;
  lastPublishAt: string | null;
  tokenExpiresAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

function safeMetadata(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toDto(row: MarketingSocialAccount): SocialAccountDto {
  return {
    id: row.id,
    gymId: row.gymId,
    platform: row.platform,
    accountName: row.accountName,
    externalAccountId: row.externalAccountId,
    status: row.status,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastPublishAt: row.lastPublishAt?.toISOString() ?? null,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    metadata: safeMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSocialAccounts(gymId: number): Promise<{
  accounts: SocialAccountDto[];
  availablePlatforms: Array<{
    platform: string;
    configured: boolean;
    enabled?: boolean;
    connectedCount: number;
  }>;
}> {
  const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { id: true } });
  if (!gym) throw new NotFoundError('Gym', gymId);

  const rows = await prisma.marketingSocialAccount.findMany({
    where: { gymId },
    orderBy: [{ platform: 'asc' }, { accountName: 'asc' }, { id: 'asc' }],
  });

  const connectedByPlatform = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== 'CONNECTED') continue;
    connectedByPlatform.set(row.platform, (connectedByPlatform.get(row.platform) || 0) + 1);
  }

  const oauthStatus = await listOAuthAppPublicStatus();

  return {
    accounts: rows.map(toDto),
    availablePlatforms: oauthStatus.map((p) => ({
      platform: p.platform,
      configured: p.configured,
      enabled: p.enabled,
      connectedCount: connectedByPlatform.get(p.platform) || 0,
    })),
  };
}

export async function startSocialOAuthConnect(params: {
  gymId: number;
  platform: string;
  actorUserId: number;
  actorRole: string;
}): Promise<{ platform: string; authorizeUrl: string }> {
  const gym = await prisma.gym.findUnique({ where: { id: params.gymId }, select: { id: true } });
  if (!gym) throw new NotFoundError('Gym', params.gymId);

  const provider = getSocialOAuthProvider(params.platform);
  const appConfig = await requireRuntimeOAuthApp(provider.platform);

  const state = signMarketingOAuthState({
    gymId: params.gymId,
    platform: provider.platform,
    platformUserId: params.actorUserId,
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_SOCIAL_CONNECT_START',
    targetGymId: params.gymId,
    metadata: { platform: provider.platform },
  });

  return {
    platform: provider.platform,
    authorizeUrl: provider.getAuthorizeUrl(state, {
      clientId: appConfig.clientId,
      clientSecret: appConfig.clientSecret,
      redirectUri: appConfig.redirectUri,
    }),
  };
}

export async function handleSocialOAuthCallback(params: {
  platform: string;
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}): Promise<string> {
  let gymId = 0;
  let platform = params.platform;

  try {
    if (!params.state) {
      throw new ValidationError('Missing OAuth state');
    }
    const state = verifyMarketingOAuthState(params.state);
    gymId = state.gymId;
    platform = state.platform;

    if (params.platform !== state.platform) {
      throw new ValidationError('OAuth platform mismatch');
    }

    if (params.error) {
      return buildPortalSocialRedirect({
        gymId,
        platform,
        ok: false,
        message: params.errorDescription || params.error,
      });
    }

    if (!params.code) {
      throw new ValidationError('Missing OAuth authorization code');
    }

    const provider = getSocialOAuthProvider(state.platform);
    const appConfig = await requireRuntimeOAuthApp(state.platform);

    const tokens = await provider.exchangeCode(params.code, {
      clientId: appConfig.clientId,
      clientSecret: appConfig.clientSecret,
      redirectUri: appConfig.redirectUri,
    });
    const accounts = await provider.listConnectableAccounts(tokens);

    if (accounts.length === 0) {
      return buildPortalSocialRedirect({
        gymId,
        platform,
        ok: false,
        message: `No ${platform} pages/locations were available for this login`,
      });
    }

    const now = new Date();
    let connectedCount = 0;

    for (const account of accounts) {
      const accessTokenEnc = encryptSecret(account.accessToken);
      const refreshTokenEnc = account.refreshToken
        ? encryptSecret(account.refreshToken)
        : null;

      await prisma.marketingSocialAccount.upsert({
        where: {
          gymId_platform_externalAccountId: {
            gymId,
            platform: account.platform,
            externalAccountId: account.externalAccountId,
          },
        },
        create: {
          gymId,
          platform: account.platform,
          externalAccountId: account.externalAccountId,
          accountName: account.accountName,
          metadata: (account.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          status: 'CONNECTED',
          accessTokenEnc,
          refreshTokenEnc,
          tokenExpiresAt: account.expiresAt ?? null,
          connectedAt: now,
        },
        update: {
          accountName: account.accountName,
          metadata: (account.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          status: 'CONNECTED',
          accessTokenEnc,
          refreshTokenEnc,
          tokenExpiresAt: account.expiresAt ?? null,
          connectedAt: now,
        },
      });
      connectedCount += 1;
    }

    await writePlatformAuditLog({
      actorUserId: state.platformUserId,
      actorRole: 'SUPER_ADMIN',
      actionType: 'MARKETING_SOCIAL_CONNECT',
      targetGymId: gymId,
      metadata: {
        platform,
        connectedCount,
        externalAccountIds: accounts.map((a) => a.externalAccountId),
      },
    });

    return buildPortalSocialRedirect({
      gymId,
      platform,
      ok: true,
      connectedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OAuth connection failed';
    if (gymId > 0) {
      return buildPortalSocialRedirect({
        gymId,
        platform,
        ok: false,
        message,
      });
    }
    try {
      return await buildPortalMarketingErrorRedirect({ platform, message });
    } catch {
      return `/platform/marketing?oauth=error&platform=${encodeURIComponent(platform)}&message=${encodeURIComponent(message.slice(0, 300))}`;
    }
  }
}

export async function disconnectSocialAccount(params: {
  gymId: number;
  accountId: number;
  actorUserId: number;
  actorRole: string;
}): Promise<SocialAccountDto> {
  const row = await prisma.marketingSocialAccount.findFirst({
    where: { id: params.accountId, gymId: params.gymId },
  });
  if (!row) throw new NotFoundError('Social account', params.accountId);

  const updated = await prisma.marketingSocialAccount.update({
    where: { id: row.id },
    data: {
      status: 'DISCONNECTED',
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
    },
  });

  await writePlatformAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    actionType: 'MARKETING_SOCIAL_DISCONNECT',
    targetGymId: params.gymId,
    metadata: {
      accountId: row.id,
      platform: row.platform,
      externalAccountId: row.externalAccountId,
    },
  });

  return toDto(updated);
}

export function supportedMarketingSocialPlatforms(): MarketingSocialPlatform[] {
  return [...MARKETING_SOCIAL_PLATFORMS];
}
