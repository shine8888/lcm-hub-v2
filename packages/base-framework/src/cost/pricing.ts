/**
 * Provider pricing sheets. Copied from vendor docs at commit time.
 *
 * Numbers here are USD *per million tokens*. `costUsd(usage, model)` gives
 * the ledger figure. Pricing is deliberately data, not code — a rate
 * change is a diff, not a refactor.
 *
 * When a customer swaps providers via `llm-gateway`, this table is what
 * the cost-budget guard reads to preflight-estimate spend.
 */
export interface ModelPricing {
  provider: string;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic (as of 2025-06)
  'claude-opus-4-8': { provider: 'anthropic', inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  'claude-sonnet-4-6': { provider: 'anthropic', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1 },

  // OpenAI (approximate, kept for illustration of provider fallback)
  'gpt-4o': { provider: 'openai', inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 0 },
  'gpt-4o-mini': { provider: 'openai', inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075, cacheWritePerM: 0 },
};

export interface UsageBreakdown {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function costUsd(u: UsageBreakdown, model: string): number {
  const p = MODEL_PRICING[model];
  if (!p) throw new Error(`No pricing for model: ${model}. Add to MODEL_PRICING.`);
  const perToken = (usd: number) => usd / 1_000_000;
  return (
    u.inputTokens * perToken(p.inputPerM) +
    u.cacheReadTokens * perToken(p.cacheReadPerM) +
    u.cacheWriteTokens * perToken(p.cacheWritePerM) +
    u.outputTokens * perToken(p.outputPerM)
  );
}

export function providerOf(model: string): string {
  const p = MODEL_PRICING[model];
  if (!p) throw new Error(`No pricing for model: ${model}. Add to MODEL_PRICING.`);
  return p.provider;
}
