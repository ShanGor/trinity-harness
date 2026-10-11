import type { ModelUsage, TokenUsage, UsageCost, UsageSummary } from '@trinity-harness/contracts';
export type { ModelUsage, TokenUsage, UsageCost, UsageSummary } from '@trinity-harness/contracts';

/** Currency amounts use 14 decimal places (8 rate decimals / million tokens). */
export function moneyUnits(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100_000_000_000_000n + BigInt(fraction.padEnd(14, '0'));
}

export function moneyAmount(units: bigint): string {
  return `${units / 100_000_000_000_000n}.${(units % 100_000_000_000_000n).toString().padStart(14, '0')}`;
}

/** Optional buckets stay unknown unless every request reported them. */
export function sumTokenUsage(samples: readonly TokenUsage[]): TokenUsage {
  if (samples.length === 0) return {};
  const result: TokenUsage = {};
  const keys: (keyof TokenUsage)[] = [
    'inputTokens',
    'outputTokens',
    'uncachedInputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cacheWrite1hTokens',
    'reasoningTokens',
  ];
  for (const key of keys) {
    if (samples.every((sample) => sample[key] !== undefined)) {
      const sum = samples.reduce((total, sample) => total + sample[key]!, 0);
      if (Number.isSafeInteger(sum)) result[key] = sum;
    }
  }
  return result;
}

function costsOf(records: readonly ModelUsage[]): UsageCost[] {
  const totals = new Map<string, bigint>();
  for (const { cost } of records) {
    if (cost)
      totals.set(cost.currency, (totals.get(cost.currency) ?? 0n) + moneyUnits(cost.amount));
  }
  return [...totals].map(([currency, units]) => ({ currency, amount: moneyAmount(units) }));
}

/** Request IDs make replay/reconnect idempotent. Historical price snapshots are retained. */
export function summarizeUsage(records: readonly ModelUsage[]): UsageSummary {
  const unique = [...new Map(records.map((record) => [record.requestId, record])).values()];
  const groups = new Map<string, ModelUsage[]>();
  for (const record of unique)
    groups.set(record.model, [...(groups.get(record.model) ?? []), record]);
  return {
    requests: unique.length,
    tokens: sumTokenUsage(unique.map((record) => record.tokens)),
    costs: costsOf(unique),
    unpricedRequests: unique.filter((record) => !record.cost).length,
    models: [...groups].map(([model, entries]) => ({
      model,
      tokens: sumTokenUsage(entries.map((entry) => entry.tokens)),
      costs: costsOf(entries),
      unpricedRequests: entries.filter((entry) => !entry.cost).length,
    })),
  };
}
