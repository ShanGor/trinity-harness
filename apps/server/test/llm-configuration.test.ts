import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySessionStore, EncryptedLlmCredentials } from '@trinity-harness/core';
import {
  LlmConfigurationError,
  type LLMRequest,
  type Identity,
  type User,
  type UserStore,
  type SessionMetaStore,
  type LlmConfigurationState,
  type LlmConfigurationPort,
  type Role,
  type LlmProviderOperationsPort,
  type LlmProbeResult,
} from '@trinity-harness/contracts';
import { buildServer } from '../src/server.js';

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function fixture(role: Role = 'admin') {
  const tenantId = randomUUID(),
    userId = randomUUID(),
    sessionId = randomUUID();
  const identity: Identity = { tenantId, userId, role };
  const user: User = {
    id: userId,
    tenantId,
    email: 'test@example.com',
    role,
    createdAt: new Date().toISOString(),
  };
  const users: UserStore = {
    findById: vi.fn(async () => user),
    findByEmail: vi.fn(),
    verifyCredentials: vi.fn(),
    createUser: vi.fn(),
    listByTenant: async () => [user],
  };
  const meta = {
    id: sessionId,
    tenantId,
    userId,
    title: 'Example',
    workspaceUri: '/tmp',
    createdAt: user.createdAt,
  };
  const metas: SessionMetaStore = {
    get: async (id) => (id === sessionId ? meta : null),
    create: vi.fn(),
    close: vi.fn(),
    listForIdentity: async () => [meta],
    setPolicy: vi.fn(),
    setTitleIfEmpty: vi.fn(),
  };
  const connectionId = randomUUID(),
    deploymentId = randomUUID(),
    profileId = randomUUID();
  const configuration = {
    connections: [
      {
        id: connectionId,
        name: 'Example',
        adapter: 'openai' as const,
        endpoint: 'https://provider.example/v1',
        enabled: true,
      },
    ],
    deployments: [
      {
        id: deploymentId,
        connectionId,
        name: 'Example',
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
        name: 'Assistant',
        primary: deploymentId,
        backups: [],
        mode: 'manual' as const,
        allowedDeployments: [deploymentId],
        maxOutputTokens: 1000,
      },
    ],
    defaultProfileId: profileId,
  };
  const state: LlmConfigurationState = {
    version: 1,
    activeRevision: 1,
    source: 'database',
    draft: configuration,
    published: configuration,
    credentials: [{ connectionId, versionId: randomUUID(), revoked: false }],
  };
  const configs: LlmConfigurationPort = {
    configure: vi.fn(async () => state),
    impact: async () => ({ version: 1, unboundSessions: 0, bindings: [] }),
    read: vi.fn(async () => state),
    revision: vi.fn(async () => configuration),
    save: vi.fn(async () => state),
    publish: vi.fn(async () => state),
    replaceCredential: vi.fn(async () => state),
    revokeCredential: vi.fn(async () => state),
    credential: vi.fn(),
    activity: async () => [],
  };
  const store = new MemorySessionStore();
  const credentials = new EncryptedLlmCredentials('test', {
    test: Buffer.alloc(32, 1).toString('base64'),
  });
  const policy = {
    validateConfiguration: vi.fn(() => undefined),
    validate: vi.fn(async () => undefined),
    fetch: vi.fn() as typeof fetch,
  };
  const probes = new Map<string, LlmProbeResult>();
  const operations: LlmProviderOperationsPort = {
    beginProbe: vi.fn(async (_identity, operationId, connectionId, deploymentId, version) => {
      const old = probes.get(operationId);
      if (old) return { admitted: false, result: old };
      const result: LlmProbeResult = {
        operationId,
        connectionId,
        deploymentId,
        version,
        at: new Date().toISOString(),
        status: 'pending',
      };
      probes.set(operationId, result);
      return { admitted: true, result };
    }),
    finishProbe: vi.fn(async (_tenant, result) => {
      probes.set(result.operationId, result);
    }),
    probes: async () => [...probes.values()],
    health: async () => [],
    cooldown: async () => null,
    blocked: async () => false,
    observe: vi.fn(),
    restore: vi.fn(),
  };
  configs.credential = vi.fn(async (tenant, connection, version) =>
    credentials.seal(tenant, connection, version, 'synthetic-provider-key'),
  );
  const gateway = {
    stream: vi.fn(async (request: LLMRequest) => {
      void request;
      return (async function* () {
        yield { kind: 'usage' as const, inputTokens: 1, outputTokens: 2, uncachedInputTokens: 1 };
        yield { kind: 'finish' as const, reason: 'stop' as const };
      })();
    }),
  };
  const app = await buildServer({
    store,
    workspaceRoot: '/tmp',
    llmConfiguration: configs,
    llmOperations: operations,
    llmProbeGateway: gateway,
    llmPricing: {
      'test/model': [
        { currency: 'USD', version: 'fixture', input: '1', output: '2', minInputTokens: 0 },
      ],
    },
    llmCredentials: credentials,
    llmEndpointPolicy: policy,
    auth: {
      tokens: { issue: vi.fn(), verify: async (token) => (token === 'valid' ? identity : null) },
      users,
      metas,
      hasher: { hash: vi.fn(), verify: vi.fn() },
    },
  });
  servers.push(app);
  const headers = { authorization: 'Bearer valid' };
  return {
    app,
    operations,
    gateway,
    headers,
    user,
    users,
    configs,
    policy,
    state,
    configuration,
    store,
    sessionId,
    connectionId,
    deploymentId,
    profileId,
  };
}

describe('LLM configuration API authorization and secret boundaries', () => {
  it.each(['member', 'expert', 'viewer'] as const)(
    'denies %s direct administration calls independently of UI',
    async (role) => {
      const f = await fixture(role);
      for (const [method, url] of [
        ['GET', '/api/admin/llm/configuration'],
        ['PUT', '/api/admin/llm/configuration'],
        ['POST', '/api/admin/llm/configuration/publish'],
        ['POST', '/api/admin/llm/configuration/rollback'],
        ['PUT', `/api/admin/llm/connections/${f.connectionId}/credentials`],
        ['DELETE', `/api/admin/llm/connections/${f.connectionId}/credentials`],
        ['POST', `/api/admin/llm/connections/${f.connectionId}/test`],
        ['GET', '/api/admin/llm/activity'],
      ] as const) {
        expect(
          (await f.app.inject({ method, url, headers: f.headers })).statusCode,
          `${role} ${url}`,
        ).toBe(403);
      }
      expect(f.configs.save).not.toHaveBeenCalled();
    },
  );
  it('checks current roles rather than stale Admin tokens and fails closed on directory errors', async () => {
    const f = await fixture();
    f.user.role = 'viewer';
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/api/admin/llm/configuration',
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(401);
    f.users.findById = async () => {
      throw new Error('database unavailable');
    };
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/api/admin/llm/configuration',
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(503);
    f.users.findById = async () => ({ ...f.user, tenantId: randomUUID() });
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/llm/profiles', headers: f.headers }))
        .statusCode,
    ).toBe(401);
  });
  it('encrypts credential writes, never provides secret GET, and rejects injected secret fields', async () => {
    const f = await fixture();
    const operationId = randomUUID();
    const response = await f.app.inject({
      method: 'PUT',
      url: `/api/admin/llm/connections/${f.connectionId}/credentials`,
      headers: f.headers,
      payload: { operationId, expectedVersion: 1, secret: 'private-provider-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private-provider-key');
    const args = vi.mocked(f.configs.replaceCredential).mock.calls[0]!;
    expect(args[3]).not.toContain('private-provider-key');
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `/api/admin/llm/connections/${f.connectionId}/credentials`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(404);
    const injected = await f.app.inject({
      method: 'PUT',
      url: '/api/admin/llm/configuration',
      headers: f.headers,
      payload: {
        operationId: randomUUID(),
        expectedVersion: 1,
        configuration: { ...f.configuration, secret: 'private-provider-key' },
      },
    });
    expect(injected.statusCode).toBe(400);
    expect(injected.body).not.toContain('private-provider-key');
  });
  it('rechecks destination policy on save and rollback and returns bounded errors', async () => {
    const f = await fixture();
    f.policy.validateConfiguration.mockImplementation(() => {
      throw new LlmConfigurationError('INVALID', 'Provider endpoint denied by operator policy');
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/admin/llm/configuration/rollback',
          headers: f.headers,
          payload: {
            expectedVersion: 1,
            operationId: randomUUID(),
            restoreRevision: 1,
            reason: 'restore',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(f.configs.publish).not.toHaveBeenCalled();
  });
  it.each(['member', 'expert', 'admin', 'viewer'] as const)(
    'enforces %s session selection and tuning permissions with CAS/idempotency',
    async (role) => {
      const f = await fixture(role);
      const url = `/api/sessions/${f.sessionId}/llm-settings`;
      const basic = {
        settings: { profileId: f.profileId },
        operationId: randomUUID(),
        expectedLastSeq: 0,
      };
      const response = await f.app.inject({
        method: 'PUT',
        url,
        headers: f.headers,
        payload: basic,
      });
      expect(response.statusCode).toBe(role === 'viewer' ? 403 : 200);
      if (role === 'viewer') return;
      expect(
        (await f.app.inject({ method: 'PUT', url, headers: f.headers, payload: basic })).statusCode,
      ).toBe(200);
      const advanced = await f.app.inject({
        method: 'PUT',
        url,
        headers: f.headers,
        payload: {
          settings: { profileId: f.profileId, pinnedDeploymentId: f.deploymentId },
          expectedLastSeq: 1,
          operationId: randomUUID(),
        },
      });
      expect(advanced.statusCode).toBe(role === 'member' ? 403 : 200);
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url,
            headers: f.headers,
            payload: { ...basic, operationId: randomUUID() },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.app.inject({
            method: 'GET',
            url: `/api/sessions/${randomUUID()}/llm-settings`,
            headers: f.headers,
          })
        ).statusCode,
      ).toBe(404);
    },
  );
  it('keeps endpoint and credential metadata out of ordinary profile catalogs', async () => {
    const f = await fixture('member');
    const response = await f.app.inject({
      method: 'GET',
      url: '/api/llm/profiles',
      headers: f.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('provider.example');
    expect(response.body).not.toContain('credential');
    expect(response.json().canTune).toBe(false);
  });
});

it('tests saved connections with synthetic input, saved prices and idempotent probe admission', async () => {
  const f = await fixture();
  const payload = { operationId: randomUUID(), deploymentId: f.deploymentId, expectedVersion: 1 };
  const url = `/api/admin/llm/connections/${f.connectionId}/test`;
  const first = await f.app.inject({ method: 'POST', url, headers: f.headers, payload });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    status: 'passed',
    inputTokens: 1,
    outputTokens: 2,
    cost: { currency: 'USD', amount: '0.00000500000000' },
  });
  expect(first.body).not.toContain('synthetic-provider-key');
  expect(first.body).not.toContain('provider.example');
  const repeated = await f.app.inject({ method: 'POST', url, headers: f.headers, payload });
  expect(repeated.json()).toEqual(first.json());
  expect(f.gateway.stream).toHaveBeenCalledTimes(1);
  expect(f.gateway.stream.mock.calls[0]?.[0]).toMatchObject({
    messages: [{ role: 'user', content: 'Reply with OK. This is a synthetic connection test.' }],
  });
});

it('allows an emergency publication during DNS outage while live probes record a bounded no-dispatch failure', async () => {
  const f = await fixture();
  f.policy.validate.mockRejectedValue(
    new LlmConfigurationError('UNAVAILABLE', 'Provider address unavailable'),
  );
  const publication = await f.app.inject({
    method: 'POST',
    url: '/api/admin/llm/configuration/publish',
    headers: f.headers,
    payload: { expectedVersion: 1, operationId: randomUUID(), reason: 'Emergency switch' },
  });
  expect(publication.statusCode).toBe(200);
  expect(f.policy.validate).not.toHaveBeenCalled();
  const test = await f.app.inject({
    method: 'POST',
    url: `/api/admin/llm/connections/${f.connectionId}/test`,
    headers: f.headers,
    payload: { expectedVersion: 1, operationId: randomUUID(), deploymentId: f.deploymentId },
  });
  expect(test.statusCode).toBe(200);
  expect(test.json()).toMatchObject({ status: 'failed', inputTokens: 0, outputTokens: 0 });
  expect(f.gateway.stream).not.toHaveBeenCalled();
  expect(f.operations.finishProbe).toHaveBeenCalledTimes(1);
});

describe('direct provider configuration API', () => {
  it('accepts a connection and inline encrypted key without a model or default', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/admin/llm/providers',
      headers: f.headers,
      payload: {
        expectedVersion: 1,
        operationId: randomUUID(),
        settings: {
          providers: f.configuration.connections,
          models: [],
          routing: { defaultModel: null, automaticFallback: false, fallbackModels: [] },
        },
        keys: [{ providerId: f.connectionId, secret: 'private-inline-key' }],
      },
    });
    expect(response.statusCode).toBe(200);
    const call = vi.mocked(f.configs.configure!).mock.calls[0]![1];
    expect(call.configuration.profiles).toEqual([]);
    expect(call.sealedKeys[0]!.sealed).not.toContain('private-inline-key');
    expect(response.body).not.toContain('private-inline-key');
  });
  it('rejects Member writes and duplicate inline keys before the store', async () => {
    const member = await fixture('member');
    expect(
      (
        await member.app.inject({
          method: 'PUT',
          url: '/api/admin/llm/providers',
          headers: member.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(member.configs.configure).not.toHaveBeenCalled();
    const f = await fixture();
    const key = { providerId: f.connectionId, secret: 'private-key' };
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/admin/llm/providers',
      headers: f.headers,
      payload: {
        expectedVersion: 1,
        operationId: randomUUID(),
        settings: {
          providers: f.configuration.connections,
          models: [],
          routing: { defaultModel: null, automaticFallback: false, fallbackModels: [] },
        },
        keys: [key, key],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(f.configs.configure).not.toHaveBeenCalled();
  });
  it.each([
    ['https://api.minimax.cn/anthropic/v1', 'anthropic/MiniMax-M3', 400],
    ['https://api.minimax.cn/anthropic/v1', 'MiniMax-M3', 200],
    ['https://custom.example/v1', 'anthropic/MiniMax-M3', 200],
  ])(
    'validates upstream MiniMax IDs without rewriting custom gateway IDs (%s, %s)',
    async (endpoint, modelId, status) => {
      const f = await fixture();
      const response = await f.app.inject({
        method: 'PUT',
        url: '/api/admin/llm/providers',
        headers: f.headers,
        payload: {
          expectedVersion: 1,
          operationId: randomUUID(),
          keys: [],
          settings: {
            providers: [{ ...f.configuration.connections[0], adapter: 'anthropic', endpoint }],
            models: [{ ...f.configuration.deployments[0], modelId }],
            routing: {
              defaultModel: { providerId: f.connectionId, modelId },
              automaticFallback: false,
              fallbackModels: [],
            },
          },
        },
      });
      expect(response.statusCode).toBe(status);
      if (status === 400) {
        expect(response.json().error).toContain('without the anthropic/ prefix');
        expect(f.configs.configure).not.toHaveBeenCalled();
      } else {
        expect(
          vi.mocked(f.configs.configure!).mock.calls[0]![1].configuration.deployments[0]!.modelId,
        ).toBe(modelId);
      }
    },
  );
  it('allows Members direct model selection without Expert privileges', async () => {
    const f = await fixture('member');
    f.state.published = {
      ...f.configuration,
      profiles: [],
      defaultProfileId: '',
      routing: {
        defaultModel: { providerId: f.connectionId, modelId: 'model' },
        automaticFallback: false,
        fallbackModels: [],
      },
    };
    const response = await f.app.inject({
      method: 'PUT',
      url: `/api/sessions/${f.sessionId}/llm-settings`,
      headers: f.headers,
      payload: {
        operationId: randomUUID(),
        expectedLastSeq: 0,
        settings: { model: { providerId: f.connectionId, modelId: 'model' } },
      },
    });
    expect(response.statusCode).toBe(200);
    const events = await f.store.load(f.sessionId);
    expect(events.at(-1)).toMatchObject({
      type: 'llm/settings',
      settings: { model: { providerId: f.connectionId, modelId: 'model' } },
    });
  });
});

it('identifies a rejected connection without exposing its full endpoint or credentials', async () => {
  const f = await fixture();
  f.policy.validateConfiguration.mockImplementation(() => {
    throw new LlmConfigurationError(
      'INVALID',
      'Provider origin is not allowed. Check LLM_PROVIDER_DESTINATIONS.',
    );
  });
  const response = await f.app.inject({
    method: 'PUT',
    url: '/api/admin/llm/providers',
    headers: f.headers,
    payload: {
      expectedVersion: 1,
      operationId: randomUUID(),
      settings: {
        providers: [
          {
            ...f.configuration.connections[0]!,
            endpoint: 'https://unsupported.example/private-path',
          },
        ],
        models: [],
        routing: { defaultModel: null, automaticFallback: false, fallbackModels: [] },
      },
      keys: [{ providerId: f.connectionId, secret: 'private-inline-key' }],
    },
  });
  expect(response.statusCode).toBe(400);
  expect(response.body).toContain('Example');
  expect(response.body).toContain('https://unsupported.example');
  expect(response.body).toContain('LLM_PROVIDER_DESTINATIONS');
  expect(response.body).not.toContain('private-path');
  expect(response.body).not.toContain('private-inline-key');
  expect(f.configs.configure).not.toHaveBeenCalled();
});
