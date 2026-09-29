import { and, gte, sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';

import type { TenantQuota, UsagePort, UsageRecord } from '@trinity-harness/contracts';
import { tenantQuotaSchema } from '@trinity-harness/contracts';

import type { Db } from './client.js';
import { modelUsage, tenants } from './schema.js';

/**
 * PG-backed UsagePort (docs/design.md §15 `model_usage`, §17 配额).
 * Metering projection — insert-only; the quota check aggregates this table.
 */
export class PgUsageStore implements UsagePort {
  constructor(private readonly db: Db) {}

  async record(entry: UsageRecord): Promise<void> {
    await this.db.insert(modelUsage).values({
      tenantId: entry.tenantId,
      sessionId: entry.sessionId,
      model: entry.model,
      inputTokens: BigInt(entry.inputTokens),
      outputTokens: BigInt(entry.outputTokens),
      ...(entry.at !== undefined ? { createdAt: entry.at } : {}),
    });
  }

  async usageSince(tenantId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${modelUsage.inputTokens} + ${modelUsage.outputTokens}), 0)`,
      })
      .from(modelUsage)
      .where(
        and(eq(modelUsage.tenantId, tenantId), gte(modelUsage.createdAt, since.toISOString())),
      );
    return Number(row?.total ?? 0);
  }

  async quotaOf(tenantId: string): Promise<TenantQuota> {
    const [row] = await this.db
      .select({ quota: tenants.quota })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const parsed = tenantQuotaSchema.safeParse(row?.quota ?? {});
    return parsed.success ? parsed.data : {};
  }

  /** Tenant quota update (admin endpoint, docs/design.md §17). */
  async setQuota(tenantId: string, quota: TenantQuota): Promise<void> {
    const result = await this.db.update(tenants).set({ quota }).where(eq(tenants.id, tenantId));
    if (result.rowCount === 0) throw new Error(`tenant not found: ${tenantId}`);
  }
}
