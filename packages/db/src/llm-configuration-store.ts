import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  llmConfigurationImpactSchema,
  type LlmConfigurationImpact,
  llmSealedCredentialSchema,
  hasCapability,
  llmConfigurationSchema,
  llmPublishedConfigurationSchema,
  llmActivitySchema,
  LlmConfigurationError,
  llmConfigurationSaveSchema,
  llmConfigurationPublishSchema,
  type Identity,
  type LlmConfiguration,
  type LlmConfigurationPort,
  type LlmConfigurationState,
  type LlmActivity,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import {
  llmConfigurations as configs,
  llmConfigurationRevisions as revisions,
  llmCredentials as credentials,
  llmConfigurationOperations as operations,
  auditLog,
  users,
  sessions,
  sessionEvents,
} from './schema.js';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
/** PostgreSQL is consulted on every dispatch. No process-local active-config cache. */
export class PgLlmConfigurationStore implements LlmConfigurationPort {
  constructor(private readonly db: Db) {}

  private async state(db: Db | Transaction, tenantId: string): Promise<LlmConfigurationState> {
    const [row] = await db.select().from(configs).where(eq(configs.tenantId, tenantId));
    if (
      row &&
      (!['environment', 'database'].includes(row.source) ||
        (row.source === 'environment' && row.activeRevision !== null))
    )
      throw new LlmConfigurationError('UNAVAILABLE', 'Invalid configuration source state');
    const [published] = row?.activeRevision
      ? await db
          .select()
          .from(revisions)
          .where(and(eq(revisions.tenantId, tenantId), eq(revisions.revision, row.activeRevision)))
      : [];
    if (row?.source === 'database' && !published)
      throw new LlmConfigurationError('UNAVAILABLE', 'Published configuration unavailable');
    const draft = row?.draft ? llmConfigurationSchema.parse(row.draft) : null;
    const current = published ? llmConfigurationSchema.parse(published.configuration) : null;
    const connectionIds = [
      ...new Set(
        [...(draft?.connections ?? []), ...(current?.connections ?? [])].map(
          (connection) => connection.id,
        ),
      ),
    ];
    const keys = connectionIds.length
      ? await db
          .select({
            connectionId: credentials.connectionId,
            versionId: credentials.versionId,
            revoked: credentials.revoked,
          })
          .from(credentials)
          .where(
            and(
              eq(credentials.tenantId, tenantId),
              eq(credentials.current, true),
              inArray(credentials.connectionId, connectionIds),
            ),
          )
      : [];
    return {
      version: row?.version ?? 0,
      activeRevision: row?.activeRevision ?? null,
      source: row?.source === 'database' ? 'database' : 'environment',
      draft,
      published: current,
      credentials: keys,
    };
  }
  async impact(tenantId: string, expectedVersion: number): Promise<LlmConfigurationImpact> {
    return this.db.transaction(
      async (tx) => {
        const state = await this.state(tx, tenantId);
        if (state.version !== expectedVersion)
          throw new LlmConfigurationError(
            'CONFLICT',
            'Configuration changed; reload before reviewing',
          );
        const ids = [
          ...new Set(
            [...(state.draft?.profiles ?? []), ...(state.published?.profiles ?? [])].map(
              (profile) => profile.id,
            ),
          ),
        ];
        if (!ids.length) return { version: state.version, unboundSessions: 0, bindings: [] };
        const rows = await tx.execute<{
          profile_id: string | null;
          total: string;
          pins: string;
        }>(sql`
        with bindings as (
          select coalesce(latest.payload->'settings'->>'profileId', latest.payload->>'llmProfileId') as profile_id,
            latest.payload->'settings'->>'pinnedDeploymentId' as pin
          from ${sessions} s left join lateral (
            select payload from ${sessionEvents} where session_id = s.id and type in ('llm/settings', 'session/created') order by seq desc limit 1
          ) latest on true where s.tenant_id = ${tenantId} and s.closed_at is null
        ) select profile_id, count(*)::text as total, count(pin)::text as pins from bindings
          where profile_id is null or profile_id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}) group by profile_id
      `);
        return llmConfigurationImpactSchema.parse({
          version: state.version,
          unboundSessions: Number(rows.rows.find((row) => row.profile_id === null)?.total ?? 0),
          bindings: rows.rows
            .filter((row) => row.profile_id !== null)
            .map((row) => ({
              profileId: row.profile_id,
              sessions: Number(row.total),
              pins: Number(row.pins),
            })),
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async revision(tenantId: string, revision: number): Promise<LlmConfiguration | null> {
    const [row] = await this.db
      .select()
      .from(revisions)
      .where(and(eq(revisions.tenantId, tenantId), eq(revisions.revision, revision)));
    return row ? llmConfigurationSchema.parse(row.configuration) : null;
  }
  async read(tenantId: string): Promise<LlmConfigurationState> {
    return this.db.transaction((tx) => this.state(tx, tenantId), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  private async change(
    identity: Identity,
    expectedVersion: number,
    operationId: string,
    action: LlmActivity['action'],
    payload: unknown,
    apply: (tx: Transaction, state: LlmConfigurationState, version: number) => Promise<void>,
    reason?: string,
  ): Promise<LlmConfigurationState> {
    if (!hasCapability(identity.role, 'llm.configuration.manage'))
      throw new LlmConfigurationError('FORBIDDEN', 'Admin required');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ action, payload, expectedVersion }))
      .digest('hex');
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.tenantId}, 0))`,
      );
      const [actor] = await tx
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.id, identity.userId), eq(users.tenantId, identity.tenantId)));
      if (actor?.role !== 'admin')
        throw new LlmConfigurationError('FORBIDDEN', 'Admin access revoked');
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.tenantId}, 1))`,
      );
      await tx.insert(configs).values({ tenantId: identity.tenantId }).onConflictDoNothing();
      const [previous] = await tx
        .select()
        .from(operations)
        .where(
          and(eq(operations.tenantId, identity.tenantId), eq(operations.operationId, operationId)),
        );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new LlmConfigurationError(
            'CONFLICT',
            'Operation identifier reused with different input',
          );
        return this.state(tx, identity.tenantId);
      }
      const state = await this.state(tx, identity.tenantId);
      if (state.version !== expectedVersion)
        throw new LlmConfigurationError('CONFLICT', 'Configuration changed; reload before saving');
      const version = state.version + 1;
      await apply(tx, state, version);
      await tx.update(configs).set({ version }).where(eq(configs.tenantId, identity.tenantId));
      const activity: LlmActivity = {
        id: operationId,
        at: new Date().toISOString(),
        actor: identity.userId,
        action,
        version,
        ...(reason ? { reason } : {}),
      };
      await tx
        .insert(operations)
        .values({ tenantId: identity.tenantId, operationId, fingerprint, activity });
      // Direct durable sink in the same transaction: no Redis audit-loss window.
      await tx.insert(auditLog).values({
        id: operationId,
        tenantId: identity.tenantId,
        userId: identity.userId,
        action: `llm/${action}`,
        result: 'ok',
        detail: { version, ...(reason ? { reason } : {}) },
      });
      return this.state(tx, identity.tenantId);
    });
  }
  async save(
    identity: Identity,
    input: Parameters<LlmConfigurationPort['save']>[1],
  ): Promise<LlmConfigurationState> {
    const parsed = llmConfigurationSaveSchema.parse(input);
    return this.change(
      identity,
      parsed.expectedVersion,
      parsed.operationId,
      'draft',
      parsed.configuration,
      async (tx, state) => {
        if (state.published?.routing && !parsed.configuration.routing)
          throw new LlmConfigurationError(
            'MIGRATION_REQUIRED',
            'Use provider and model settings after migration',
          );
        await tx
          .update(configs)
          .set({ draft: parsed.configuration })
          .where(eq(configs.tenantId, identity.tenantId));
      },
    );
  }
  async publish(
    identity: Identity,
    input: Parameters<LlmConfigurationPort['publish']>[1],
  ): Promise<LlmConfigurationState> {
    const parsed = llmConfigurationPublishSchema.parse(input);
    return this.change(
      identity,
      parsed.expectedVersion,
      parsed.operationId,
      parsed.restoreRevision ? 'rollback' : 'publish',
      parsed,
      async (tx, state, version) => {
        let draft = state.draft;
        if (parsed.restoreRevision) {
          const [old] = await tx
            .select()
            .from(revisions)
            .where(
              and(
                eq(revisions.tenantId, identity.tenantId),
                eq(revisions.revision, parsed.restoreRevision),
              ),
            );
          if (!old) throw new LlmConfigurationError('INVALID', 'Unknown revision');
          draft = llmConfigurationSchema.parse(old.configuration);
        }
        if (!draft) throw new LlmConfigurationError('INVALID', 'Save a draft first');
        if (state.published?.routing && !draft.routing)
          throw new LlmConfigurationError(
            'MIGRATION_REQUIRED',
            'Legacy profile routing cannot be restored after migration',
          );
        // Drafts can be incomplete while an Admin enters a provider key/model/profile.
        // Activate only a complete, routable configuration.
        draft = llmPublishedConfigurationSchema.parse(draft);
        if (parsed.restoreRevision && state.published) {
          for (const connection of draft.connections.filter((row) => row.enabled))
            if (!state.published.connections.some((row) => row.id === connection.id && row.enabled))
              throw new LlmConfigurationError(
                'INVALID',
                'Disabled or retired connections require explicit enabling in a new draft',
              );
          for (const deployment of draft.deployments.filter((row) => row.enabled))
            if (!state.published.deployments.some((row) => row.id === deployment.id && row.enabled))
              throw new LlmConfigurationError(
                'INVALID',
                'Disabled or retired deployments require explicit enabling in a new draft',
              );
        }
        for (const connection of draft.connections.filter((c) => c.enabled))
          if (!state.credentials.some((key) => key.connectionId === connection.id && !key.revoked))
            throw new LlmConfigurationError(
              'INVALID',
              'Enabled connections require a current credential',
            );
        await tx
          .insert(revisions)
          .values({ tenantId: identity.tenantId, revision: version, configuration: draft });
        await tx
          .update(configs)
          .set({ activeRevision: version, draft, source: 'database' })
          .where(eq(configs.tenantId, identity.tenantId));
      },
      parsed.reason,
    );
  }
  async configure(
    identity: Identity,
    input: NonNullable<Parameters<NonNullable<LlmConfigurationPort['configure']>>[1]>,
  ): Promise<LlmConfigurationState> {
    const configuration = llmConfigurationSchema.parse(input.configuration);
    if (!configuration.routing || configuration.profiles.length)
      throw new LlmConfigurationError('INVALID', 'Direct model configuration required');
    const keys = input.sealedKeys.map((row) => ({
      ...row,
      digest: llmSealedCredentialSchema.parse(JSON.parse(row.sealed)).digest,
    }));
    return this.change(
      identity,
      input.expectedVersion,
      input.operationId,
      'configure',
      { configuration, keys: keys.map(({ connectionId, digest }) => ({ connectionId, digest })) },
      async (tx, state, version) => {
        for (const row of keys) {
          if (!configuration.connections.some((provider) => provider.id === row.connectionId))
            throw new LlmConfigurationError('INVALID', 'Unknown provider for key');
          await tx
            .update(credentials)
            .set({ current: false })
            .where(
              and(
                eq(credentials.tenantId, identity.tenantId),
                eq(credentials.connectionId, row.connectionId),
              ),
            );
          await tx.insert(credentials).values({
            tenantId: identity.tenantId,
            connectionId: row.connectionId,
            versionId: input.operationId,
            sealed: row.sealed,
          });
        }
        for (const provider of configuration.connections.filter((row) => row.enabled))
          if (
            !keys.some((row) => row.connectionId === provider.id) &&
            !state.credentials.some((row) => row.connectionId === provider.id && !row.revoked)
          )
            throw new LlmConfigurationError(
              'INVALID',
              'Enter an API key for each new enabled connection',
            );
        // Connecting alone does not switch an existing environment deployment.
        // Once managed, even a cleared default stays managed and fails closed at dispatch.
        const active = !!configuration.routing!.defaultModel || state.source === 'database';
        if (active)
          await tx
            .insert(revisions)
            .values({ tenantId: identity.tenantId, revision: version, configuration });
        await tx
          .update(configs)
          .set({
            draft: configuration,
            ...(active ? { activeRevision: version, source: 'database' } : {}),
          })
          .where(eq(configs.tenantId, identity.tenantId));
      },
    );
  }
  async replaceCredential(
    identity: Identity,
    connectionId: string,
    input: Parameters<LlmConfigurationPort['replaceCredential']>[2],
    sealed: string,
  ): Promise<LlmConfigurationState> {
    // The authenticated encryption envelope carries a keyed idempotency digest,
    // not an offline-testable plaintext credential hash.
    const digest = llmSealedCredentialSchema.parse(JSON.parse(sealed));
    return this.change(
      identity,
      input.expectedVersion,
      input.operationId,
      'credential.replace',
      { connectionId, digest: digest.digest },
      async (tx, state) => {
        if (!state.draft?.connections.some((c) => c.id === connectionId))
          throw new LlmConfigurationError('INVALID', 'Connection missing from draft');
        await tx
          .update(credentials)
          .set({ current: false })
          .where(
            and(
              eq(credentials.tenantId, identity.tenantId),
              eq(credentials.connectionId, connectionId),
            ),
          );
        await tx.insert(credentials).values({
          tenantId: identity.tenantId,
          connectionId,
          versionId: input.operationId,
          sealed,
        });
      },
    );
  }
  async revokeCredential(
    identity: Identity,
    connectionId: string,
    input: Parameters<LlmConfigurationPort['revokeCredential']>[2],
  ): Promise<LlmConfigurationState> {
    return this.change(
      identity,
      input.expectedVersion,
      input.operationId,
      'credential.revoke',
      { connectionId },
      async (tx) => {
        await tx
          .update(credentials)
          .set({ revoked: true })
          .where(
            and(
              eq(credentials.tenantId, identity.tenantId),
              eq(credentials.connectionId, connectionId),
            ),
          );
      },
    );
  }
  async credential(
    tenantId: string,
    connectionId: string,
    versionId: string,
  ): Promise<string | null> {
    const [key] = await this.db
      .select({ sealed: credentials.sealed })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenantId, tenantId),
          eq(credentials.connectionId, connectionId),
          eq(credentials.versionId, versionId),
          eq(credentials.revoked, false),
          eq(credentials.current, true),
        ),
      );
    return key?.sealed ?? null;
  }
  async activity(tenantId: string): Promise<LlmActivity[]> {
    const rows = await this.db
      .select({ activity: operations.activity })
      .from(operations)
      .where(eq(operations.tenantId, tenantId))
      .orderBy(desc(sql`(${operations.activity}->>'version')::bigint`))
      .limit(100);
    return rows.map((row) => llmActivitySchema.parse(row.activity));
  }
}
