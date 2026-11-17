import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import {
  llmHealthSnapshotSchema,
  type LlmHealthSnapshot,
  type LlmCooldown,
  LlmConfigurationError,
  hasCapability,
  llmProbeResultSchema,
  tenantQuotaSchema,
  windowStart,
  type Identity,
  type LlmProbeResult,
  type LlmProviderOperationsPort,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import {
  llmProbes as probes,
  llmHealth as health,
  llmHealthObservations as observations,
  llmConfigurations as configs,
  users,
  tenants,
  modelUsage,
} from './schema.js';

/** Shared PG leases/health. A passing explicit probe is required to reopen a circuit. */
export class PgLlmProviderOperations implements LlmProviderOperationsPort {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}
  async beginProbe(
    identity: Identity,
    operationId: string,
    connectionId: string,
    deploymentId: string,
    expectedVersion: number,
  ): Promise<{ admitted: boolean; result: LlmProbeResult }> {
    if (!hasCapability(identity.role, 'llm.configuration.manage'))
      throw new LlmConfigurationError('FORBIDDEN', 'Admin required');
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.tenantId}, 2))`,
      );
      const [user] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, identity.userId), eq(users.tenantId, identity.tenantId)));
      if (user?.role !== 'admin')
        throw new LlmConfigurationError('FORBIDDEN', 'Admin access revoked');
      const [existing] = await tx
        .select()
        .from(probes)
        .where(and(eq(probes.tenantId, identity.tenantId), eq(probes.operationId, operationId)));
      if (existing) {
        if (
          existing.connectionId !== connectionId ||
          existing.deploymentId !== deploymentId ||
          existing.version !== expectedVersion
        )
          throw new LlmConfigurationError('CONFLICT', 'Probe identifier reused');
        return { admitted: false, result: llmProbeResultSchema.parse(existing.result) };
      }
      const [config] = await tx
        .select()
        .from(configs)
        .where(eq(configs.tenantId, identity.tenantId));
      if (config?.version !== expectedVersion)
        throw new LlmConfigurationError('CONFLICT', 'Configuration changed; reload before testing');
      const recent = await tx
        .select()
        .from(probes)
        .where(
          and(
            eq(probes.tenantId, identity.tenantId),
            gte(probes.startedAt, new Date(this.now() - 3600000).toISOString()),
          ),
        );
      if (
        recent.length >= 10 ||
        recent.some(
          (row) =>
            llmProbeResultSchema.parse(row.result).status === 'pending' &&
            Date.parse(row.startedAt) > this.now() - 30000,
        )
      )
        throw new LlmConfigurationError(
          'UNAVAILABLE',
          'Synthetic tests limited to one concurrent request and ten per hour per tenant',
        );
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, identity.tenantId));
      const quota = tenantQuotaSchema.parse(tenant?.quota ?? {});
      for (const [window, limit] of [
        ['hour', quota.hourlyTokens],
        ['day', quota.dailyTokens],
        ['month', quota.monthlyTokens],
      ] as const) {
        if (!limit) continue;
        const [total] = await tx
          .select({
            value: sql<string>`coalesce(sum(${modelUsage.inputTokens} + ${modelUsage.outputTokens}), 0)`,
          })
          .from(modelUsage)
          .where(
            and(
              eq(modelUsage.tenantId, identity.tenantId),
              gte(modelUsage.createdAt, windowStart(window, new Date(this.now())).toISOString()),
            ),
          );
        // Unknown probes retain their conservative reservation; they cannot
        // become free requests after a process crash or unavailable usage.
        const unresolved = await tx
          .select()
          .from(probes)
          .where(
            and(
              eq(probes.tenantId, identity.tenantId),
              gte(probes.startedAt, windowStart(window, new Date(this.now())).toISOString()),
            ),
          );
        const reserved =
          unresolved.filter((row) => {
            const probe = llmProbeResultSchema.parse(row.result);
            return (
              ['pending', 'unknown'].includes(probe.status) ||
              probe.inputTokens === undefined ||
              probe.outputTokens === undefined
            );
          }).length * 256;
        if (Number(total?.value ?? 0) + reserved + 256 > limit)
          throw new LlmConfigurationError(
            'UNAVAILABLE',
            'Tenant token quota prevents synthetic test',
          );
      }
      const result: LlmProbeResult = {
        operationId,
        connectionId,
        deploymentId,
        version: expectedVersion,
        at: new Date(this.now()).toISOString(),
        status: 'pending',
      };
      await tx.insert(probes).values({
        tenantId: identity.tenantId,
        operationId,
        connectionId,
        deploymentId,
        version: expectedVersion,
        startedAt: result.at,
        result,
      });
      return { admitted: true, result };
    });
  }
  async finishProbe(tenantId: string, result: LlmProbeResult): Promise<void> {
    const parsed = llmProbeResultSchema.parse(result);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(probes)
        .where(and(eq(probes.tenantId, tenantId), eq(probes.operationId, parsed.operationId)))
        .for('update');
      if (!row || llmProbeResultSchema.parse(row.result).status !== 'pending') return;
      await tx
        .update(probes)
        .set({ result: parsed })
        .where(and(eq(probes.tenantId, tenantId), eq(probes.operationId, parsed.operationId)));
      if (parsed.inputTokens !== undefined || parsed.outputTokens !== undefined)
        await tx.insert(modelUsage).values({
          tenantId,
          sessionId: parsed.operationId,
          model: `synthetic/${parsed.deploymentId}`,
          inputTokens: BigInt(parsed.inputTokens ?? 0),
          outputTokens: BigInt(parsed.outputTokens ?? 0),
        });
    });
  }
  async probes(tenantId: string): Promise<LlmProbeResult[]> {
    const rows = await this.db
      .select()
      .from(probes)
      .where(eq(probes.tenantId, tenantId))
      .orderBy(desc(probes.startedAt))
      .limit(100);
    return rows.map((row) => {
      const result = llmProbeResultSchema.parse(row.result);
      return result.status === 'pending' && Date.parse(row.startedAt) < this.now() - 30000
        ? { ...result, status: 'unknown' }
        : result;
    });
  }
  async health(tenantId: string): Promise<LlmHealthSnapshot[]> {
    const rows = await this.db
      .select()
      .from(health)
      .where(eq(health.tenantId, tenantId))
      .orderBy(desc(health.observedAt))
      .limit(100);
    return rows.map((row) =>
      llmHealthSnapshotSchema.parse({
        deploymentId: row.deploymentId,
        credentialVersionId: row.credentialVersionId,
        state: row.open ? 'open' : 'closed',
        observedAt: new Date(row.observedAt).toISOString(),
        failures: row.failures,
        credentialBlocked: row.credentialBlocked,
        ...([row.retryAt, row.connectionRetryAt].some(
          (value) => value && Date.parse(value) > this.now(),
        )
          ? {
              retryAt: new Date(
                Math.max(
                  ...[row.retryAt, row.connectionRetryAt].map((value) =>
                    value ? Date.parse(value) : 0,
                  ),
                ),
              ).toISOString(),
            }
          : {}),
      }),
    );
  }
  async cooldown(
    tenantId: string,
    connectionId: string,
    deploymentId: string,
  ): Promise<string | null> {
    const until = sql<string>`greatest(case when ${health.deploymentId} = ${deploymentId} then ${health.retryAt} end, case when ${health.connectionId} = ${connectionId} then ${health.connectionRetryAt} end)`;
    const [row] = await this.db
      .select({ retryAt: until })
      .from(health)
      .where(
        and(
          eq(health.tenantId, tenantId),
          or(
            and(
              eq(health.deploymentId, deploymentId),
              gte(health.retryAt, new Date(this.now()).toISOString()),
            ),
            and(
              eq(health.connectionId, connectionId),
              gte(health.connectionRetryAt, new Date(this.now()).toISOString()),
            ),
          ),
        ),
      )
      .orderBy(desc(until))
      .limit(1);
    return row?.retryAt ? new Date(row.retryAt).toISOString() : null;
  }
  async blocked(
    tenantId: string,
    deploymentId: string,
    credentialVersionId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(health)
      .where(
        and(
          eq(health.tenantId, tenantId),
          or(eq(health.deploymentId, deploymentId), eq(health.credentialBlocked, true)),
          eq(health.open, true),
          eq(health.credentialVersionId, credentialVersionId),
        ),
      );
    return row?.open ?? false;
  }
  async observe(
    tenantId: string,
    requestId: string,
    deploymentId: string,
    credentialVersionId: string,
    outcome: 'success' | 'transient' | 'permanent',
    cooldown?: LlmCooldown,
    connectionId = deploymentId,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(observations)
        .values({ tenantId, requestId })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) return;
      await tx
        .insert(health)
        .values({ tenantId, deploymentId, credentialVersionId, connectionId })
        .onConflictDoNothing();
      const where = and(
        eq(health.tenantId, tenantId),
        eq(health.deploymentId, deploymentId),
        eq(health.credentialVersionId, credentialVersionId),
      );
      const [row] = await tx.select().from(health).where(where).for('update');
      const failures =
        outcome === 'success'
          ? 0
          : (Date.parse(row!.observedAt) < this.now() - 60000 ? 0 : row!.failures) + 1;
      await tx
        .update(health)
        .set({
          failures,
          open: row!.open || outcome === 'permanent' || failures >= 3,
          connectionId,
          ...(cooldown?.scope === 'deployment' &&
          (!row!.retryAt || Date.parse(cooldown.until) > Date.parse(row!.retryAt))
            ? { retryAt: cooldown.until }
            : {}),
          ...(cooldown?.scope === 'connection' &&
          (!row!.connectionRetryAt ||
            Date.parse(cooldown.until) > Date.parse(row!.connectionRetryAt))
            ? { connectionRetryAt: cooldown.until }
            : {}),
          credentialBlocked: row!.credentialBlocked || outcome === 'permanent',
          observedAt: new Date(this.now()).toISOString(),
        })
        .where(where);
    });
  }
  async restore(
    tenantId: string,
    deploymentId: string,
    credentialVersionId: string,
  ): Promise<void> {
    await this.db
      .update(health)
      .set({
        open: false,
        failures: 0,
        credentialBlocked: false,
        observedAt: new Date(this.now()).toISOString(),
      })
      .where(
        and(
          eq(health.tenantId, tenantId),
          or(eq(health.deploymentId, deploymentId), eq(health.credentialBlocked, true)),
          eq(health.credentialVersionId, credentialVersionId),
        ),
      );
  }
}
