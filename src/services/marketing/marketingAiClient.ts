import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';
import { requireRuntimeAiConfig } from './marketingSettingsService';

export type MarketingAiOperationType =
  | 'OPPORTUNITY_GENERATION'
  | 'SOCIAL_POST_GENERATION'
  | 'IMAGE_PROMPT_GENERATION'
  | 'IMAGE_GENERATION'
  | 'REGENERATION'
  | 'BLOG_GENERATION';

export type AiChatResult = {
  content: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export type AiImageResult = {
  provider: string;
  model: string;
  imageBuffer: Buffer;
  mimeType: string;
  costUsd: number | null;
};

/** Rough USD estimates for metering (not billing). */
export function estimateOpenAiChatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number | null {
  const m = model.toLowerCase();
  let inputPerM = 0.15;
  let outputPerM = 0.6;
  if (m.includes('gpt-4.1-mini') || m.includes('gpt-4o-mini')) {
    inputPerM = 0.15;
    outputPerM = 0.6;
  } else if (m.includes('gpt-4.1') || m.includes('gpt-4o')) {
    inputPerM = 2.5;
    outputPerM = 10;
  } else if (m.includes('gpt-3.5')) {
    inputPerM = 0.5;
    outputPerM = 1.5;
  }
  const cost =
    (promptTokens / 1_000_000) * inputPerM + (completionTokens / 1_000_000) * outputPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function estimateOpenAiImageCostUsd(model: string): number | null {
  const m = model.toLowerCase();
  if (m.includes('dall-e-3')) return 0.04;
  if (m.includes('dall-e-2')) return 0.02;
  if (m.includes('gpt-image')) return 0.04;
  return 0.04;
}

function chatCompletionsUrl(baseUrl: string | null): string {
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  return `${base}/chat/completions`;
}

function imagesUrl(baseUrl: string | null): string {
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  return `${base}/images/generations`;
}

export async function callMarketingChatJson(params: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<AiChatResult> {
  const cfg = await requireRuntimeAiConfig('text');
  const model = cfg.textModel;

  const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: params.temperature ?? 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
    }),
  });

  const raw = (await res.json()) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  if (!res.ok) {
    throw new AppError(
      'AI_PROVIDER_ERROR',
      raw.error?.message || `Marketing AI request failed (${res.status})`,
      502
    );
  }

  const content = raw.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new AppError('AI_PROVIDER_ERROR', 'Marketing AI returned empty content', 502);
  }

  const promptTokens = raw.usage?.prompt_tokens ?? 0;
  const completionTokens = raw.usage?.completion_tokens ?? 0;
  const totalTokens = raw.usage?.total_tokens ?? promptTokens + completionTokens;

  return {
    content,
    provider: cfg.provider,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: estimateOpenAiChatCostUsd(model, promptTokens, completionTokens),
  };
}

export async function callMarketingImageGeneration(params: {
  prompt: string;
}): Promise<AiImageResult> {
  const cfg = await requireRuntimeAiConfig('image');
  const model = cfg.imageModel;

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt.slice(0, 3900),
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json',
  };
  if (model.toLowerCase().includes('dall-e-3')) {
    body.quality = 'standard';
  }

  const res = await fetch(imagesUrl(cfg.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = (await res.json()) as {
    error?: { message?: string };
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  if (!res.ok) {
    throw new AppError(
      'AI_PROVIDER_ERROR',
      raw.error?.message || `Marketing image generation failed (${res.status})`,
      502
    );
  }

  const first = raw.data?.[0];
  let imageBuffer: Buffer | null = null;
  let mimeType = 'image/png';

  if (first?.b64_json) {
    imageBuffer = Buffer.from(first.b64_json, 'base64');
  } else if (first?.url) {
    const imgRes = await fetch(first.url);
    if (!imgRes.ok) {
      throw new AppError('AI_PROVIDER_ERROR', 'Failed to download generated image', 502);
    }
    const arr = await imgRes.arrayBuffer();
    imageBuffer = Buffer.from(arr);
    const ct = imgRes.headers.get('content-type');
    if (ct) mimeType = ct.split(';')[0].trim() || mimeType;
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    throw new AppError('AI_PROVIDER_ERROR', 'Marketing image provider returned no image data', 502);
  }

  return {
    provider: cfg.provider,
    model,
    imageBuffer,
    mimeType,
    costUsd: estimateOpenAiImageCostUsd(model),
  };
}

export async function recordMarketingAiUsage(params: {
  gymId: number;
  platformUserId?: number | null;
  operationType: MarketingAiOperationType;
  provider: string;
  model: string;
  tokens: number | null;
  costUsd: number | null;
}): Promise<void> {
  await prisma.marketingAiUsage.create({
    data: {
      gymId: params.gymId,
      platformUserId: params.platformUserId ?? null,
      operationType: params.operationType,
      provider: params.provider,
      model: params.model,
      tokens: params.tokens,
      costUsd: params.costUsd,
    },
  });
}

export function parseJsonObject<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AppError('AI_PARSE_ERROR', `Failed to parse ${label} JSON from AI`, 502);
  }
}
