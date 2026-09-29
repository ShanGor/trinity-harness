import { z } from 'zod';

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
