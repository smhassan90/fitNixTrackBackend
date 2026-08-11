import { prisma } from '../../lib/prisma';
import { AppError, ValidationError } from '../../utils/errors';

export type MarketingAiOperationType =
  | 'OPPORTUNITY_GENERATION'
  | 'SOCIAL_POST_GENERATION';

export type AiChatResult = {
  content: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

/** Rough USD estimates for metering (not billing). */
export function estimateOpenAiChatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number | null {
  const m = model.toLowerCase();
  // Approximate per-1M token rates
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

function getMarketingAiConfig(): { provider: string; model: string; apiKey: string } {
  const provider = (process.env.MARKETING_AI_PROVIDER || 'openai').trim().toLowerCase();
  const model = (process.env.MARKETING_AI_MODEL || 'gpt-4o-mini').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();

  if (provider !== 'openai') {
    throw new ValidationError(`Unsupported MARKETING_AI_PROVIDER: ${provider}`);
  }
  if (!apiKey) {
    throw new AppError(
      'AI_NOT_CONFIGURED',
      'OPENAI_API_KEY is not configured for marketing AI',
      503
    );
  }
  return { provider, model, apiKey };
}

export async function callMarketingChatJson(params: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<AiChatResult> {
  const { provider, model, apiKey } = getMarketingAiConfig();

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
    provider,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: estimateOpenAiChatCostUsd(model, promptTokens, completionTokens),
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
