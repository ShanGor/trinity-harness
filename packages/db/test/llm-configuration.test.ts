import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  createPool,
  createTenant,
  PgLlmConfigurationStore,
  PgLlmProviderOperations,
  PgSessionMetaStore,
  PgSessionStore,
  PgUserStore,
  identityOf,
} from '../src/index.js';
import type { Identity, LlmConfiguration } from '@trinity-harness/contracts';

const url = process.env['TRINITY_TEST_LLM_DATABASE_URL'];
describe.skipIf(!url)('tenant LLM PostgreSQL control plane', () => {
  const pool = createPool(url ?? 'postgresql://invalid');
  const db = createDb(pool);
  const users = new PgUserStore(db, { hash: async (value) => value, verify: async () => false });
  const configs = new PgLlmConfigurationStore(db);
  const ops = new PgLlmProviderOperations(db);
  let admin: Identity;
  let configuration: LlmConfiguration;
  beforeAll(async () => {
    const tenant = await createTenant(db, `llm-test-${randomUUID()}`);
    admin = identityOf(
      await users.createUser({
        tenantId: tenant.id,
        email: `${randomUUID()}@test.invalid`,
        role: 'admin',
        passwordHash: 'unused',
      }),
    );
    const connectionId = randomUUID(),
      deploymentId = randomUUID(),
      profileId = randomUUID();
    configuration = {
      connections: [
        {
          id: connectionId,
          name: 'Example',
          adapter: 'openai',
          endpoint: 'https://provider.example/v1',
          enabled: true,
        },
      ],
      deployments: [
        {
          id: deploymentId,
          name: 'Example model',
          connectionId,
          modelId: 'test-model',
          pricingKey: 'example/model',
          enabled: true,
          contextTokens: 10000,
          outputTokens: 1000,
          capabilities: { tools: true, images: false, files: false, reasoning: false },
          settings: {},
        },
      ],
      profiles: [
        {
          id: profileId,
          name: 'Assistant',
          primary: deploymentId,
          backups: [],
          mode: 'manual',
          allowedDeployments: [deploymentId],
          maxOutputTokens: 1000,
        },
      ],
      defaultProfileId: profileId,
    };
  });
  afterAll(async () => {
    await pool.end();
  });
  it('defaults new tenants to legacy source and rejects non-admin writes', async () => {
    expect(await configs.read(admin.tenantId)).toMatchObject({
      version: 0,
      source: 'environment',
      published: null,
    });
    await expect(
      configs.save(
        { ...admin, role: 'expert' },
        { expectedVersion: 0, operationId: randomUUID(), configuration },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('serializes concurrent CAS saves, retries lost responses and rejects operation reuse', async () => {
    const operationId = randomUUID();
    const input = { expectedVersion: 0, operationId, configuration };
    const results = await Promise.allSettled([
      configs.save(admin, input),
      configs.save(admin, { ...input, operationId: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winning = results[0]!.status === 'fulfilled' ? input : null;
    if (winning) {
      expect((await configs.save(admin, winning)).version).toBe(1);
      await expect(
        configs.save(admin, {
          ...winning,
          configuration: {
            ...configuration,
            connections: [{ ...configuration.connections[0]!, name: 'Changed' }],
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    expect((await configs.activity(admin.tenantId)).length).toBe(1);
  });
  it('publishes atomically with write-only credentials and a durable audit row', async () => {
    let state = await configs.read(admin.tenantId);
    await expect(
      configs.publish(admin, {
        expectedVersion: state.version,
        operationId: randomUUID(),
        reason: 'Review',
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    state = await configs.replaceCredential(
      admin,
      configuration.connections[0]!.id,
      { expectedVersion: state.version, operationId: randomUUID() },
      JSON.stringify({
        version: 1,
        wrappedKey: '',
        wrapIv: '',
        wrapTag: '',
        keyId: 'test',
        iv: '',
        tag: '',
        digest: 'a'.repeat(64),
        body: 'encrypted-secret',
      }),
    );
    expect(JSON.stringify(state)).not.toContain('encrypted-secret');
    const operationId = randomUUID();
    state = await configs.publish(admin, {
      expectedVersion: state.version,
      operationId,
      reason: 'Reviewed configuration',
    });
    expect(state.source).toBe('database');
    expect(state.activeRevision).toBe(state.version);
    const audit = await pool.query('select detail from audit_log where id=$1', [operationId]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain('encrypted-secret');
    const other = await createTenant(db, `other-${randomUUID()}`);
    expect(
      await configs.credential(
        other.id,
        configuration.connections[0]!.id,
        state.credentials[0]!.versionId,
      ),
    ).toBeNull();
  });
  it('reviews default bindings, explicit pins and unbound sessions against the exact configuration version', async () => {
    const metas = new PgSessionMetaStore(db),
      events = new PgSessionStore(db);
    const profileId = configuration.defaultProfileId;
    for (const kind of ['default', 'pin', 'unbound']) {
      const sessionId = randomUUID();
      await metas.create({
        id: sessionId,
        tenantId: admin.tenantId,
        userId: admin.userId,
        title: kind,
        workspaceUri: '/test',
      });
      await events.append(sessionId, [
        {
          type: 'session/created',
          eventId: randomUUID(),
          at: new Date().toISOString(),
          workspaceUri: '/test',
          ...(kind === 'default' ? { llmProfileId: profileId } : {}),
        },
      ]);
      if (kind === 'pin')
        await events.append(sessionId, [
          {
            type: 'llm/settings',
            eventId: randomUUID(),
            at: new Date().toISOString(),
            operationId: randomUUID(),
            settings: { profileId, pinnedDeploymentId: configuration.deployments[0]!.id },
          },
        ]);
    }
    const state = await configs.read(admin.tenantId);
    expect(await configs.impact(admin.tenantId, state.version)).toEqual({
      version: state.version,
      unboundSessions: 1,
      bindings: [{ profileId, sessions: 2, pins: 1 }],
    });
    await expect(configs.impact(admin.tenantId, state.version - 1)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('keeps revocation authoritative across rollback and fresh adapter instances', async () => {
    const old = await configs.read(admin.tenantId);
    const state = await configs.revokeCredential(admin, configuration.connections[0]!.id, {
      expectedVersion: old.version,
      operationId: randomUUID(),
    });
    expect(
      await new PgLlmConfigurationStore(db).credential(
        admin.tenantId,
        configuration.connections[0]!.id,
        state.credentials[0]!.versionId,
      ),
    ).toBeNull();
    await expect(
      configs.publish(admin, {
        expectedVersion: state.version,
        operationId: randomUUID(),
        reason: 'Restore',
        restoreRevision: old.activeRevision!,
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect((await configs.read(admin.tenantId)).source).toBe('database');
  });
  it('protects the last Admin under concurrent demotions without granting cross-tenant access', async () => {
    const peer = await users.createUser({
      tenantId: admin.tenantId,
      email: `${randomUUID()}@test.invalid`,
      role: 'admin',
      passwordHash: 'unused',
    });
    const results = await Promise.all([
      users.setRole(admin.tenantId, admin.userId, 'member'),
      users.setRole(admin.tenantId, peer.id, 'member'),
    ]);
    expect(results.sort()).toEqual(['last_admin', 'updated']);
    const survivor = (await users.listByTenant(admin.tenantId)).find(
      (user) => user.role === 'admin',
    )!;
    admin = identityOf(survivor);
    expect(await users.setRole(randomUUID(), survivor.id, 'expert')).toBe('not_found');
  });
  it('shares idempotent circuit state across adapters and requires explicit probe restore', async () => {
    const deployment = configuration.deployments[0]!.id,
      credential = randomUUID(),
      requestId = randomUUID();
    await ops.observe(admin.tenantId, requestId, deployment, credential, 'transient');
    await ops.observe(admin.tenantId, requestId, deployment, credential, 'transient');
    expect(await ops.blocked(admin.tenantId, deployment, credential)).toBe(false);
    await ops.observe(admin.tenantId, randomUUID(), deployment, credential, 'transient');
    await ops.observe(admin.tenantId, randomUUID(), deployment, credential, 'transient');
    const replica = new PgLlmProviderOperations(db);
    expect(await replica.blocked(admin.tenantId, deployment, credential)).toBe(true);
    await replica.observe(admin.tenantId, randomUUID(), deployment, credential, 'success');
    expect(await ops.blocked(admin.tenantId, deployment, credential)).toBe(true);
    await replica.restore(admin.tenantId, deployment, credential);
    expect(await ops.blocked(admin.tenantId, deployment, credential)).toBe(false);
  });
  it('leases synthetic tests once across replicas and records usage only once outside conversations', async () => {
    const state = await configs.read(admin.tenantId),
      connection = configuration.connections[0]!.id,
      deployment = configuration.deployments[0]!.id,
      operation = randomUUID();
    const first = await ops.beginProbe(admin, operation, connection, deployment, state.version);
    expect(first.admitted).toBe(true);
    expect(
      (
        await new PgLlmProviderOperations(db).beginProbe(
          admin,
          operation,
          connection,
          deployment,
          state.version,
        )
      ).admitted,
    ).toBe(false);
    await expect(
      ops.beginProbe(admin, randomUUID(), connection, deployment, state.version),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await ops.finishProbe(admin.tenantId, {
      ...first.result,
      status: 'passed',
      inputTokens: 20,
      outputTokens: 2,
    });
    await ops.finishProbe(admin.tenantId, {
      ...first.result,
      status: 'passed',
      inputTokens: 20,
      outputTokens: 2,
    });
    const result = await pool.query('select count(*) from model_usage where session_id=$1', [
      operation,
    ]);
    expect(Number(result.rows[0].count)).toBe(1);
  });
});

// Source/immutability and impact tests use only the explicitly opted-in fixture DB.
describe.skipIf(!url)('LLM activation and binding fences', () => {
  const pool = createPool(url ?? 'postgresql://invalid');
  const db = createDb(pool);
  let tenantId: string;
  beforeAll(async () => {
    const tenant = await createTenant(db, `llm-fence-${randomUUID()}`);
    tenantId = tenant.id;
    const directory = new PgUserStore(db, {
      hash: async (value) => value,
      verify: async () => false,
    });
    const actor = identityOf(
      await directory.createUser({
        tenantId,
        email: `${randomUUID()}@test.invalid`,
        passwordHash: 'unused',
        role: 'admin',
      }),
    );
    const connectionId = randomUUID(),
      deploymentId = randomUUID(),
      profileId = randomUUID();
    const configuration: LlmConfiguration = {
      connections: [
        {
          id: connectionId,
          name: 'Connection',
          adapter: 'openai',
          endpoint: 'https://example.test/v1',
          enabled: true,
        },
      ],
      deployments: [
        {
          id: deploymentId,
          connectionId,
          name: 'Model',
          modelId: 'model',
          pricingKey: 'test/model',
          enabled: true,
          contextTokens: 10000,
          outputTokens: 1000,
          capabilities: { tools: true, images: false, files: false, reasoning: false },
          settings: {},
        },
      ],
      profiles: [
        {
          id: profileId,
          name: 'Profile',
          primary: deploymentId,
          backups: [],
          mode: 'manual',
          allowedDeployments: [deploymentId],
          maxOutputTokens: 1000,
        },
      ],
      defaultProfileId: profileId,
    };
    const store = new PgLlmConfigurationStore(db);
    await store.save(actor, { expectedVersion: 0, operationId: randomUUID(), configuration });
    await store.replaceCredential(
      actor,
      connectionId,
      { expectedVersion: 1, operationId: randomUUID() },
      JSON.stringify({
        version: 1,
        wrappedKey: '',
        wrapIv: '',
        wrapTag: '',
        keyId: 'test',
        iv: '',
        tag: '',
        digest: 'a'.repeat(64),
        body: 'opaque',
      }),
    );
    await store.publish(actor, {
      expectedVersion: 2,
      operationId: randomUUID(),
      reason: 'Fixture',
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  it('keeps immutable revisions and activated source mode protected at the database boundary', async () => {
    await expect(
      pool.query('update llm_configurations set source=$1 where tenant_id=$2', [
        'environment',
        tenantId,
      ]),
    ).rejects.toThrow('cannot return to environment');
    await expect(
      pool.query('delete from llm_configurations where tenant_id=$1', [tenantId]),
    ).rejects.toThrow('cannot be deleted');
    await expect(
      pool.query(
        'update llm_configuration_revisions set configuration=configuration where tenant_id=$1',
        [tenantId],
      ),
    ).rejects.toThrow('append-only');
  });
  it('keeps permanent credential failures shared across deployments using that credential', async () => {
    const ops = new PgLlmProviderOperations(db),
      credential = randomUUID(),
      deployment = randomUUID();
    await ops.observe(tenantId, randomUUID(), deployment, credential, 'permanent');
    expect(await ops.blocked(tenantId, randomUUID(), credential)).toBe(true);
    await ops.restore(tenantId, deployment, credential);
    expect(await ops.blocked(tenantId, deployment, credential)).toBe(false);
  });
  it('shares independent retry deadlines across workers and credential rotations', async () => {
    let now = Date.now();
    const ops = new PgLlmProviderOperations(db, () => now);
    const replica = new PgLlmProviderOperations(db, () => now);
    const connection = randomUUID(),
      deployment = randomUUID(),
      credential = randomUUID();
    const modelWait = new Date(now + 120000).toISOString();
    const connectionWait = new Date(now + 60000).toISOString();
    await ops.observe(
      tenantId,
      randomUUID(),
      deployment,
      credential,
      'transient',
      { until: modelWait, scope: 'deployment' },
      connection,
    );
    await ops.observe(
      tenantId,
      randomUUID(),
      deployment,
      credential,
      'transient',
      { until: connectionWait, scope: 'connection' },
      connection,
    );
    expect(await replica.cooldown(tenantId, connection, deployment)).toBe(modelWait);
    expect(await replica.cooldown(tenantId, connection, randomUUID())).toBe(connectionWait);
    expect(await replica.cooldown(tenantId, randomUUID(), randomUUID())).toBeNull();
    await ops.observe(
      tenantId,
      randomUUID(),
      deployment,
      randomUUID(),
      'success',
      undefined,
      connection,
    );
    await ops.restore(tenantId, deployment, credential);
    expect(await replica.cooldown(tenantId, connection, deployment)).toBe(modelWait);
    now += 61000;
    expect(await replica.cooldown(tenantId, connection, randomUUID())).toBeNull();
    expect(await replica.cooldown(tenantId, connection, deployment)).toBe(modelWait);
    now += 60000;
    expect(await replica.cooldown(tenantId, connection, deployment)).toBeNull();
  });
});

describe.skipIf(!url)('atomic direct provider settings', () => {
  const pool = createPool(url ?? 'postgresql://invalid');
  const db = createDb(pool);
  const store = new PgLlmConfigurationStore(db);
  const users = new PgUserStore(db, { hash: async (value) => value, verify: async () => false });
  afterAll(async () => {
    await pool.end();
  });
  it('connects with an inline key independently, activates a default and never returns to environment', async () => {
    const tenant = await createTenant(db, `direct-${randomUUID()}`);
    const admin = identityOf(
      await users.createUser({
        tenantId: tenant.id,
        email: `${randomUUID()}@test.invalid`,
        passwordHash: 'unused',
        role: 'admin',
      }),
    );
    const connectionId = randomUUID(),
      operationId = randomUUID();
    const configuration: LlmConfiguration = {
      connections: [
        {
          id: connectionId,
          name: 'Kimi',
          adapter: 'openai',
          endpoint: 'https://api.kimi.com/coding/v1',
          enabled: true,
        },
      ],
      deployments: [],
      profiles: [],
      defaultProfileId: '',
      routing: { defaultModel: null, automaticFallback: false, fallbackModels: [] },
    };
    const sealed = JSON.stringify({
      version: 1,
      keyId: 'test',
      wrappedKey: '',
      wrapIv: '',
      wrapTag: '',
      iv: '',
      tag: '',
      body: 'encrypted',
      digest: 'a'.repeat(64),
    });
    const input = {
      expectedVersion: 0,
      operationId,
      configuration,
      sealedKeys: [{ connectionId, sealed }],
    };
    const saved = await store.configure(admin, input);
    expect(saved.source).toBe('environment');
    expect(saved.version).toBe(1);
    expect(saved.published).toBeNull();
    expect(saved.credentials[0]).toMatchObject({ connectionId, revoked: false });
    expect(JSON.stringify(saved)).not.toContain('encrypted');
    expect((await new PgLlmConfigurationStore(db).configure(admin, input)).version).toBe(1);
    const model = {
      id: randomUUID(),
      name: 'Kimi model',
      connectionId,
      modelId: 'k3-256k',
      pricingKey: 'unpriced',
      enabled: true,
      contextTokens: 262144,
      outputTokens: 8192,
      capabilities: { tools: true, images: false, files: false, reasoning: true },
      settings: {},
    };
    configuration.deployments.push(model);
    configuration.routing!.defaultModel = { providerId: connectionId, modelId: model.modelId };
    const active = await store.configure(admin, {
      expectedVersion: 1,
      operationId: randomUUID(),
      configuration,
      sealedKeys: [],
    });
    expect(active.source).toBe('database');
    expect(active.published?.profiles).toEqual([]);
    expect(active.credentials[0]?.versionId).toBe(operationId);
    await expect(
      store.configure(admin, {
        expectedVersion: 1,
        operationId: randomUUID(),
        configuration,
        sealedKeys: [],
      }),
    ).rejects.toThrow('Configuration changed');
    configuration.routing!.defaultModel = null;
    const cleared = await store.configure(admin, {
      expectedVersion: 2,
      operationId: randomUUID(),
      configuration,
      sealedKeys: [],
    });
    expect(cleared.source).toBe('database');
    expect(cleared.published?.routing?.defaultModel).toBeNull();
    const failedConfiguration = {
      ...configuration,
      connections: [
        ...configuration.connections,
        { ...configuration.connections[0]!, id: randomUUID() },
      ],
    };
    await expect(
      store.configure(admin, {
        expectedVersion: 3,
        operationId: randomUUID(),
        configuration: failedConfiguration,
        sealedKeys: [{ connectionId, sealed }],
      }),
    ).rejects.toThrow('Enter an API key');
    const after = await store.read(tenant.id);
    expect(after.version).toBe(3);
    expect(after.credentials[0]?.versionId).toBe(operationId);
    expect(after.draft?.connections).toHaveLength(1);
  });
});
