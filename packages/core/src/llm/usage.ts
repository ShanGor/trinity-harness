import type { ModelPrice, ModelPricing, TokenUsage, UsageCost } from '@trinity-harness/contracts';
import { moneyAmount, moneyUnits } from '@trinity-harness/shared';

/** Derive only buckets forced by the provider's exact input total. */
export function normalizeTokenUsage(tokens: TokenUsage): TokenUsage {
  const result = { ...tokens };
  const keys = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
  if (result.inputTokens === undefined && keys.every((key) => result[key] !== undefined)) {
    const total = keys.reduce((sum, key) => sum + result[key]!, 0);
    if (Number.isSafeInteger(total)) result.inputTokens = total;
  }
  if (result.inputTokens !== undefined) {
    const known = keys.reduce((sum, key) => sum + (result[key] ?? 0), 0);
    const missing = keys.filter((key) => result[key] === undefined);
    if (known === result.inputTokens) for (const key of missing) result[key] = 0;
    else if (missing.length === 1 && known < result.inputTokens)
      result[missing[0]!] = result.inputTokens - known;
  }
  return result;
}

export function priceUsage(
  model: string,
  tokens: TokenUsage,
  prices: ModelPricing,
): {
  pricing?: ModelPrice;
  cost?: UsageCost;
} {
  const t = normalizeTokenUsage(tokens);
  if (t.inputTokens === undefined || t.outputTokens === undefined) return {};
  const selected = prices[model]
    ?.filter((price) => price.minInputTokens <= t.inputTokens!)
    .sort((a, b) => b.minInputTokens - a.minInputTokens)[0];
  if (!selected) return {};
  const pricing = { ...selected };
  if (
    t.uncachedInputTokens === undefined ||
    t.cacheReadTokens === undefined ||
    t.cacheWriteTokens === undefined
  )
    return { pricing };
  if (t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens !== t.inputTokens)
    return { pricing };
  // Without a reported TTL split, differing cache-write rates cannot be priced exactly.
  if (
    t.cacheWriteTokens > 0 &&
    pricing.cacheWrite1h !== undefined &&
    pricing.cacheWrite1h !== pricing.cacheWrite &&
    t.cacheWrite1hTokens === undefined
  )
    return { pricing };
  if ((t.cacheWrite1hTokens ?? 0) > t.cacheWriteTokens) return { pricing };
  const oneHour = pricing.cacheWrite1h !== undefined ? (t.cacheWrite1hTokens ?? 0) : 0;
  const buckets = [
    [t.uncachedInputTokens, pricing.input],
    [t.outputTokens!, pricing.output],
    [t.cacheReadTokens, pricing.cacheRead],
    [t.cacheWriteTokens - oneHour, pricing.cacheWrite],
    [oneHour, pricing.cacheWrite1h],
  ] as const;
  let amount = 0n;
  for (const [count, rate] of buckets) {
    if (count === 0) continue;
    if (rate === undefined) return { pricing };
    amount += BigInt(count) * (moneyUnits(rate) / 1_000_000n);
  }
  return { pricing, cost: { currency: pricing.currency, amount: moneyAmount(amount) } };
}
