import { z } from 'zod';

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Input totals include cache reads/writes; reasoning is a subset of output. */
export const tokenUsageSchema = z.object({
  inputTokens: tokenCount.optional(),
  outputTokens: tokenCount.optional(),
  uncachedInputTokens: tokenCount.optional(),
  cacheReadTokens: tokenCount.optional(),
  cacheWriteTokens: tokenCount.optional(),
  cacheWrite1hTokens: tokenCount.optional(),
  reasoningTokens: tokenCount.optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/** Decimal currency units per million tokens, supplied by the operator. */
const rateSchema = z.string().regex(/^\d{1,9}(\.\d{1,8})?$/);
export const modelPriceSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  version: z.string().min(1).max(100),
  input: rateSchema,
  output: rateSchema,
  cacheRead: rateSchema.optional(),
  cacheWrite: rateSchema.optional(),
  cacheWrite1h: rateSchema.optional(),
  /** Select this tier for requests with at least this many input tokens. */
  minInputTokens: tokenCount.default(0),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;
export const modelPricingSchema = z.record(
  z.string().min(1).max(200),
  z.array(modelPriceSchema).min(1).max(16),
);
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export const modelPricingConfigSchema = z.object({ models: modelPricingSchema }).strict();

export const usageCostSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Exact decimal amount; only rounded for display. */
  amount: z
    .string()
    .max(64)
    .regex(/^\d+\.\d{14}$/),
});
export type UsageCost = z.infer<typeof usageCostSchema>;

export const modelUsageSchema = z.object({
  requestId: z.uuid(),
  promptId: z.uuid(),
  model: z.string().min(1).max(200),
  purpose: z.enum(['assistant', 'compaction', 'subagent']),
  tokens: tokenUsageSchema,
  pricing: modelPriceSchema.optional(),
  cost: usageCostSchema.optional(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

/**
 * Usage & quota contracts (docs/design.md §17 配额). Token usage is recorded
 * per model request by the Agent Loop into `model_usage` (PG) and aggregated
 * per tenant over calendar windows (hour/day/month); the `beforeModelCall`
 * gate denies new model requests once a tenant exceeds its quota.
 */

/** One recorded model request's token consumption. */
export interface UsageRecord {
  tenantId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** ISO-8601 UTC; defaults to now in implementations that omit it. */
  at?: string | undefined;
}

/**
 * Per-tenant token quota. Absent/undefined fields are UNLIMITED (0 is also
 * treated as unlimited — quotas are opt-in by tenant admins).
 */
export const tenantQuotaSchema = z.object({
  /** Rolling calendar-hour window (top of the hour). */
  hourlyTokens: z.number().int().positive().optional(),
  /** Rolling calendar-day window (midnight UTC). */
  dailyTokens: z.number().int().positive().optional(),
  /** Calendar-month window (1st 00:00 UTC). */
  monthlyTokens: z.number().int().positive().optional(),
  /** Phone/speech quotas (docs/voice-call-design.md §8.4): max concurrent
   *  streaming ASR connections per tenant. */
  concurrentAsrStreams: z.number().int().positive().optional(),
  /** WebRTC media sessions per tenant (docs/webrtc-media-design.md §5);
   *  enforced when the media gateway adapter is composed. */
  concurrentMediaSessions: z.number().int().positive().optional(),
  /** Max concurrent TTS synthesis streams per tenant. */
  concurrentTtsStreams: z.number().int().positive().optional(),
  /** Uploaded/transcribed audio bytes per rolling hour (batch + streaming). */
  hourlyAsrBytes: z.number().int().positive().optional(),
  /** Synthesized characters per rolling hour. */
  hourlyTtsCharacters: z.number().int().positive().optional(),
  /** Combined speech API requests (batch + stream opens) per rolling minute. */
  speechRequestsPerMinute: z.number().int().positive().optional(),
});
export type TenantQuota = z.infer<typeof tenantQuotaSchema>;

export type QuotaWindow = 'hour' | 'day' | 'month';

export interface QuotaCheck {
  allowed: boolean;
  /** Present when denied: which window exceeded, and how much is used. */
  exceeded?: { window: QuotaWindow; limit: number; used: number } | undefined;
}

/**
 * Usage write side + quota read side (docs/design.md §17). Implemented by
 * packages/db (`PgUsageStore`); consumed by the Agent Loop (record + gate).
 * Recording is best-effort (a failure must never break a turn); the quota
 * check is fail-closed: a store failure denies the request (AGENTS.md §3.4).
 */
export interface UsagePort {
  record(entry: UsageRecord): Promise<void>;
  /** Sum of (input+output) tokens for the tenant since a window start. */
  usageSince(tenantId: string, since: Date): Promise<number>;
  /** The tenant's configured quota (empty object ⇒ unlimited). */
  quotaOf(tenantId: string): Promise<TenantQuota>;
}

/**
 * Tenant-quota administration (docs/design.md §17): set/raise a tenant's
 * token quota. Implemented by packages/db (`PgUsageStore`); exposed via the
 * admin REST endpoint; every change is audited.
 */
export interface QuotaAdminPort {
  setQuota(tenantId: string, quota: TenantQuota): Promise<void>;
}

/** Window start (UTC) for a quota window, relative to `now`. */
export function windowStart(window: QuotaWindow, now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (window === 'hour') return d;
  d.setUTCHours(0, 0, 0, 0);
  if (window === 'day') return d;
  d.setUTCDate(1);
  return d;
}

export const usageSummarySchema = z.object({
  requests: tokenCount,
  tokens: tokenUsageSchema,
  costs: z.array(usageCostSchema),
  unpricedRequests: tokenCount,
  models: z.array(
    z.object({
      model: z.string(),
      tokens: tokenUsageSchema,
      costs: z.array(usageCostSchema),
      unpricedRequests: tokenCount,
    }),
  ),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
