import { tokenCounter, modelLatency } from '../src/telemetry.js';
import { randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  taskBudgetSchema,
  LlmConfigurationError,
  hasCapability,
  roleSchema,
  historicalRoleSchema,
  llmConfigurationSchema,
  type Identity,
  type LlmConfigurationPort,
  type LlmConfigurationState,
  type UserStore,
  type LlmProviderOperationsPort,
  type SessionMetaStore,
  type LlmCredentialPort,
  type LlmResolvedRoute,
  type LLMRequest,
} from '@trinity-harness/contracts';
import {
  infrastructureCredentials,
  priceUsage,
  EventTaskExecution,
  AiSdkGateway,
  EncryptedLlmCredentials,
  ProviderEndpointPolicy,
  isPublicProviderAddress,
  TenantLlmRouting,
  HmacTokenService,
  MemorySessionStore,
  CoreAgentLoop,
  CoreToolRegistry,
} from '../src/index.js';
import { FakeSandbox, textChunks } from '../src/testing/index.js';

function fixture() {
  const tenantId = randomUUID(),
    userId = randomUUID();
  const connections = [0, 1].map((index) => ({
    id: randomUUID(),
    name: `Connection ${index}`,
    adapter: 'openai' as const,
    endpoint: `https://provider${index}.example/v1`,
    enabled: true,
  }));
  const deployments = connections.map((connection, index) => ({
    id: randomUUID(),
    name: `Model ${index}`,
    connectionId: connection.id,
    modelId: `model${index}`,
    pricingKey: `fake/model${index}`,
    enabled: true,
    contextTokens: 200000,
    outputTokens: 8192,
    capabilities: { tools: true, images: false, files: false, reasoning: false },
    settings: {},
  }));
  const profile = {
    id: randomUUID(),
    name: 'Assistant',
    primary: deployments[0]!.id,
    backups: [deployments[1]!.id],
    mode: 'automatic' as const,
    allowedDeployments: deployments.map((row) => row.id),
    maxOutputTokens: 8192,
  };
  const configuration = {
    connections,
    deployments,
    profiles: [profile],
    defaultProfileId: profile.id,
  };
  let state: LlmConfigurationState = {
    version: 1,
    activeRevision: 1,
    source: 'database',
    draft: configuration,
    published: configuration,
    credentials: connections.map((row) => ({
      connectionId: row.id,
      versionId: randomUUID(),
      revoked: false,
    })),
  };
  const configs: LlmConfigurationPort = {
    impact: async () => ({ version: 1, unboundSessions: 0, bindings: [] }),
    revision: async () => configuration,
    read: async () => structuredClone(state),
    credential: async () => 'sealed',
    save: vi.fn(),
    publish: vi.fn(),
    replaceCredential: vi.fn(),
    revokeCredential: vi.fn(),
    activity: async () => [],
  };
  const identity: Identity = { tenantId, userId, role: 'member' };
  const user = {
    id: userId,
    tenantId,
    email: 'member@example.com',
    role: identity.role,
    createdAt: new Date().toISOString(),
  };
  const users: UserStore = {
    findById: async () => ({ ...user }),
    findByEmail: async () => null,
    verifyCredentials: async () => null,
    createUser: vi.fn(),
    listByTenant: async () => [user],
  };
  const sessionId = randomUUID();
  const meta = {
    id: sessionId,
    tenantId,
    userId,
    title: 'Example',
    workspaceUri: '/ws',
    createdAt: new Date().toISOString(),
  };
  const metas: SessionMetaStore = {
    get: async (id) => (id === sessionId ? meta : null),
    create: vi.fn(),
    listForIdentity: async () => [meta],
    close: vi.fn(),
    setPolicy: vi.fn(),
    setTitleIfEmpty: vi.fn(),
  };
  const store = new MemorySessionStore();
  const credential: LlmCredentialPort = { seal: vi.fn(), open: async () => 'private-api-key' };
  const policy = {
    validateConfiguration: vi.fn(() => undefined),
    validate: vi.fn(async (endpoint: string): Promise<void> => {
      void endpoint;
    }),
    fetch: vi.fn() as typeof fetch,
  };
  const operations: LlmProviderOperationsPort = {
    beginProbe: vi.fn(),
    finishProbe: vi.fn(),
    probes: async () => [],
    health: async () => [],
    cooldown: async () => null,
    blocked: async () => false,
    observe: vi.fn(),
    restore: vi.fn(),
  };
  const routing = new TenantLlmRouting(
    configs,
    credential,
    policy,
    users,
    store,
    metas,
    undefined,
    operations,
  );
  const request: LLMRequest = {
    model: 'legacy/model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  };
  return {
    tenantId,
    sessionId,
    user,
    identity,
    configuration,
    profile,
    state,
    configs,
    policy,
    routing,
    store,
    request,
    deployments,
    connections,
    updateState: (next: LlmConfigurationState): void => {
      state = next;
    },
  };
}

describe('account capabilities and token transition', () => {
  it('grants full assistant usage without implicit Expert access', () => {
    for (const role of roleSchema.options) {
      expect(hasCapability(role, 'assistant.run')).toBe(role !== 'viewer');
      expect(hasCapability(role, 'llm.session.tune')).toBe(['admin', 'expert'].includes(role));
      expect(hasCapability(role, 'llm.configuration.manage')).toBe(role === 'admin');
    }
    expect(roleSchema.safeParse('developer').success).toBe(false);
    expect(historicalRoleSchema.parse('developer')).toBe('member');
    expect(historicalRoleSchema.safeParse('unknown').success).toBe(false);
  });
  it('reads unexpired legacy claims but never issues them; malformed expiries fail closed', async () => {
    const secret = 'test-secret-long-enough';
    const tokens = new HmacTokenService(secret, 1000, () => 100);
    const body = Buffer.from(JSON.stringify({ u: 'user', t: 'tenant', r: 'developer' })).toString(
      'base64url',
    );
    const sign = (expiry: string): string =>
      `${body}.${expiry}.${createHmac('sha256', secret).update(`${body}.${expiry}`).digest('base64url')}`;
    expect(await tokens.verify(sign('200'))).toEqual({
      userId: 'user',
      tenantId: 'tenant',
      role: 'member',
    });
    expect(await tokens.verify(sign('NaN'))).toBeNull();
    expect(await tokens.verify(`${sign('200')}.extra`)).toBeNull();
    await expect(
      tokens.issue({ userId: 'u', tenantId: 't', role: 'developer' as Identity['role'] }),
    ).rejects.toThrow();
  });
});

describe('provider credentials and endpoints', () => {
  it('binds authenticated ciphertext to tenant, connection and version, supports key rotation and never exposes plaintext', async () => {
    const oldKey = Buffer.alloc(32, 1).toString('base64'),
      newKey = Buffer.alloc(32, 2).toString('base64');
    const original = new EncryptedLlmCredentials('old', { old: oldKey });
    const sealed = await original.seal('tenant', 'connection', 'version', 'private-key');
    expect(sealed).not.toContain('private-key');
    const rotated = new EncryptedLlmCredentials('new', { old: oldKey, new: newKey });
    expect(await rotated.open('tenant', 'connection', 'version', sealed)).toBe('private-key');
    for (const args of [
      ['other', 'connection', 'version'],
      ['tenant', 'other', 'version'],
      ['tenant', 'connection', 'other'],
    ])
      await expect(rotated.open(args[0]!, args[1]!, args[2]!, sealed)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    await expect(
      new EncryptedLlmCredentials('new', { new: newKey }).open(
        'tenant',
        'connection',
        'version',
        sealed,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('denies private/reserved/mapped addresses and unapproved origins', async () => {
    for (const address of [
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '100.64.0.1',
      '192.0.2.1',
      '224.0.0.1',
      '::1',
      '::ffff:8.8.8.8',
      'fc00::1',
      '2001:db8::1',
    ])
      expect(isPublicProviderAddress(address), address).toBe(false);
    expect(isPublicProviderAddress('8.8.8.8')).toBe(true);
    const policy = new ProviderEndpointPolicy([{ origin: 'https://127.0.0.1' }]);
    for (const endpoint of [
      'https://127.0.0.1/v1',
      'http://127.0.0.1/v1',
      'https://u:p@127.0.0.1/v1',
      'https://127.0.0.1:8443/v1',
      'https://127.0.0.1/v1?secret=x',
    ])
      await expect(policy.validate(endpoint)).rejects.toThrow();
    await expect(
      new ProviderEndpointPolicy([{ origin: 'https://127.0.0.1', allowPrivate: true }]).validate(
        'https://127.0.0.1/v1',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('tenant routing and recovery', () => {
  it('validates closed configuration, references, duplicate targets and adapter options', () => {
    const f = fixture();
    expect(llmConfigurationSchema.safeParse(f.configuration).success).toBe(true);
    expect(
      llmConfigurationSchema.safeParse({ ...f.configuration, headers: { authorization: 'bad' } })
        .success,
    ).toBe(false);
    expect(
      llmConfigurationSchema.safeParse({
        ...f.configuration,
        profiles: [{ ...f.profile, backups: [f.profile.primary] }],
      }).success,
    ).toBe(false);
    expect(
      llmConfigurationSchema.safeParse({
        ...f.configuration,
        deployments: [{ ...f.deployments[0], connectionId: randomUUID() }],
      }).success,
    ).toBe(false);
  });
  it('binds a new conversation once, follows published profile updates, and rejects downgrade/pin revocation', async () => {
    const f = fixture();
    expect((await f.routing.session(f.sessionId, f.identity.userId))?.settings.profileId).toBe(
      f.profile.id,
    );
    const first = await f.routing.resolve(f.identity, { profileId: f.profile.id }, f.request, []);
    expect(first.receipt.deploymentId).toBe(f.profile.primary);
    f.configuration.profiles[0]!.primary = f.deployments[1]!.id;
    f.configuration.profiles[0]!.backups = [f.deployments[0]!.id];
    expect(
      (await f.routing.resolve(f.identity, { profileId: f.profile.id }, f.request, [])).receipt
        .deploymentId,
    ).toBe(f.deployments[1]!.id);
    await expect(
      f.routing.resolve(
        f.identity,
        { profileId: f.profile.id, pinnedDeploymentId: f.profile.primary },
        f.request,
        [],
      ),
    ).rejects.toMatchObject({ code: 'STALE_OVERRIDE' });
    f.user.role = 'expert';
    const pin = await f.routing.resolve(
      { ...f.identity, role: 'expert' },
      { profileId: f.profile.id, pinnedDeploymentId: f.profile.primary },
      f.request,
      [],
    );
    f.user.role = 'member';
    await expect(f.routing.admit(f.identity, pin)).rejects.toMatchObject({
      code: 'STALE_OVERRIDE',
    });
    f.state.credentials.forEach((key) => {
      key.revoked = true;
    });
    await expect(f.routing.admit(f.identity, first)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('fails closed when configuration reads fail, and rejects incompatible or signed-history backup routes', async () => {
    const f = fixture();
    const attempted = [
      { deploymentId: f.deployments[0]!.id, connectionId: f.connections[0]!.id, output: false },
    ];
    expect(
      (await f.routing.resolve(f.identity, { profileId: f.profile.id }, f.request, attempted))
        .receipt.reason,
    ).toBe('fallback');
    await expect(
      f.routing.resolve(
        f.identity,
        { profileId: f.profile.id },
        {
          ...f.request,
          tools: [{ name: 'tool', description: '', parameters: {} }],
          messages: [
            {
              role: 'assistant',
              content: '',
              reasoning: [{ text: 'reason', signature: 'signed' }],
            },
          ],
        },
        attempted,
        f.deployments[0]!.id,
      ),
    ).rejects.toThrow();
    f.configs.read = async () => {
      throw new Error('database unavailable');
    };
    await expect(f.routing.session(f.sessionId, f.identity.userId)).rejects.toThrow(
      'database unavailable',
    );
  });
  it('switches immediately after no-output failure using the same recovery budget and records actual deployment usage', async () => {
    const f = fixture();
    let count = 0;
    const wait = vi.fn(async () => undefined);
    const routes: LlmResolvedRoute[] = [];
    const loop = new CoreAgentLoop({
      store: f.store,
      workspaceRoot: '/ws',
      model: 'legacy/model',
      routing: f.routing,
      tools: new CoreToolRegistry(new FakeSandbox()),
      now: () => Date.now(),
      wait,
      llm: {
        stream: async (_request, route) => {
          routes.push(route!);
          count += 1;
          if (count === 1) throw Object.assign(new Error('overloaded'), { statusCode: 503 });
          return (async function* () {
            yield* textChunks('Recovered');
          })();
        },
      },
    });
    expect(
      (
        await loop.run(
          f.sessionId,
          'hello',
          { emit: () => undefined },
          { actor: f.identity.userId, tenantId: f.identity.tenantId },
        )
      ).reason,
    ).toBe('completed');
    expect(routes.map((route) => route.receipt.deploymentId)).toEqual(
      f.deployments.map((row) => row.id),
    );
    expect(wait).not.toHaveBeenCalled();
    const events = await f.store.load(f.sessionId);
    const routeEvents = events.filter((event) => event.type === 'model/route');
    expect(routeEvents).toHaveLength(2);
    expect(
      routeEvents[0]?.type === 'model/route' &&
        routeEvents[1]?.type === 'model/route' &&
        routeEvents[0].logicalRequestId === routeEvents[1].logicalRequestId,
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private-api-key');
    const usage = events.filter((event) => event.type === 'model/usage');
    expect(
      usage.map((event) => event.type === 'model/usage' && event.usage.route?.deploymentId),
    ).toEqual(f.deployments.map((row) => row.id));
  });
});

it.each([401, 429, 503, 403])(
  'uses independent approved backups only for eligible failures (HTTP %s)',
  async (statusCode) => {
    const f = fixture();
    const routes: string[] = [];
    const wait = vi.fn(async () => undefined);
    const loop = new CoreAgentLoop({
      store: f.store,
      model: 'legacy/model',
      tools: new CoreToolRegistry(new FakeSandbox()),
      workspaceRoot: '/ws',
      routing: f.routing,
      wait,
      llm: {
        stream: async (_request, route) => {
          routes.push(route!.receipt.deploymentId);
          if (routes.length === 1)
            throw Object.assign(new Error('provider failed'), {
              statusCode,
              responseHeaders: { 'retry-after': '60' },
            });
          return (async function* () {
            yield* textChunks('Backup answer');
          })();
        },
      },
    });
    const result = await loop.run(
      f.sessionId,
      'hello',
      { emit: () => undefined },
      { actor: f.identity.userId, tenantId: f.tenantId },
    );
    expect(result.reason).toBe(statusCode === 403 ? 'error' : 'completed');
    expect(routes.length).toBe(statusCode === 403 ? 1 : 2);
    expect(wait).not.toHaveBeenCalled();
  },
);

it('does not execute incomplete tool calls or change providers after any tool output', async () => {
  const f = fixture();
  const tools = new CoreToolRegistry(new FakeSandbox());
  const execute = vi.fn(async () => ({ value: 'effect', isError: false }));
  tools.register({ name: 'effect', description: 'test', parameters: z.object({}), execute });
  let calls = 0;
  const loop = new CoreAgentLoop({
    store: f.store,
    model: 'legacy/model',
    tools,
    workspaceRoot: '/ws',
    routing: f.routing,
    llm: {
      stream: async () => {
        calls++;
        return (async function* () {
          yield {
            kind: 'tool-call' as const,
            call: { id: 'incomplete', name: 'effect', args: {} },
          };
          throw Object.assign(new Error('failed stream'), { statusCode: 503 });
        })();
      },
    },
  });
  expect(
    (
      await loop.run(
        f.sessionId,
        'hello',
        { emit: () => undefined },
        { actor: f.identity.userId, tenantId: f.tenantId },
      )
    ).reason,
  ).toBe('error');
  expect(calls).toBe(1);
  expect(execute).not.toHaveBeenCalled();
});

it('does not resend an uncertain receipt after restart, and retains recovery ceilings for a known failed attempt', async () => {
  for (const uncertain of [true, false]) {
    const f = fixture();
    const promptId = randomUUID(),
      requestId = randomUUID(),
      logicalRequestId = randomUUID();
    const route = await f.routing.resolve(f.identity, { profileId: f.profile.id }, f.request, []);
    const meta = (): { eventId: string; at: string } => ({
      eventId: randomUUID(),
      at: new Date().toISOString(),
    });
    await f.store.append(f.sessionId, [
      {
        ...meta(),
        eventId: promptId,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'hello' }],
      },
      {
        ...meta(),
        type: 'llm/settings',
        operationId: randomUUID(),
        settings: { profileId: f.profile.id },
      },
      {
        ...meta(),
        type: 'model/route',
        promptId,
        requestId,
        logicalRequestId,
        purpose: 'assistant',
        receipt: route.receipt,
      },
      ...(uncertain
        ? []
        : [
            {
              ...meta(),
              type: 'model/route_result' as const,
              promptId,
              requestId,
              logicalRequestId,
              deploymentId: route.receipt.deploymentId,
              connectionId: route.receipt.connectionId,
              output: false,
              success: false,
            },
            ...Array.from({ length: 3 }, () => ({
              ...meta(),
              type: 'task/recovery' as const,
              promptId,
              kind: 'retry' as const,
              advice: 'Persisted provider recovery',
            })),
          ]),
    ]);
    const stream = vi.fn(async () => {
      throw Object.assign(new Error('still overloaded'), { statusCode: 503 });
    });
    const restarted = new CoreAgentLoop({
      store: f.store,
      model: 'legacy/model',
      tools: new CoreToolRegistry(new FakeSandbox()),
      workspaceRoot: '/ws',
      routing: f.routing,
      llm: { stream },
    });
    expect(
      (
        await restarted.run(
          f.sessionId,
          'hello',
          { emit: () => undefined },
          { actor: f.identity.userId, tenantId: f.tenantId, promptSeq: 1 },
        )
      ).reason,
    ).toBe('error');
    expect(stream).toHaveBeenCalledTimes(uncertain ? 0 : 1);
    const recoveries = (await f.store.load(f.sessionId)).filter(
      (event) => event.type === 'task/recovery',
    );
    expect(recoveries.length).toBe(uncertain ? 0 : 3);
  }
});

it('durably journals child routing before dispatch and prevents a call when that journal cannot be saved', async () => {
  for (const failJournal of [false, true]) {
    const f = fixture(),
      child = randomUUID(),
      parentPromptId = randomUUID();
    const childStore = new MemorySessionStore();
    const original = f.store.append.bind(f.store);
    if (failJournal)
      vi.spyOn(f.store, 'append').mockImplementation(async (session, events, options) => {
        if (events.some((event) => event.type === 'model/route'))
          throw new Error('durable journal unavailable');
        return original(session, events, options);
      });
    const stream = vi.fn(async () => {
      expect(
        (await f.store.load(f.sessionId)).some(
          (event) => event.type === 'model/route' && event.promptId === parentPromptId,
        ),
      ).toBe(true);
      return (async function* () {
        yield* textChunks('Child answer');
      })();
    });
    const loop = new CoreAgentLoop({
      store: childStore,
      model: 'legacy/model',
      tools: new CoreToolRegistry(new FakeSandbox()),
      workspaceRoot: '/ws',
      routing: f.routing,
      routingSessionId: f.sessionId,
      routingJournal: { store: f.store, sessionId: f.sessionId, promptId: parentPromptId },
      llm: { stream },
    });
    expect(
      (
        await loop.run(
          child,
          'child task',
          { emit: () => undefined },
          {
            actor: `subagent:${f.sessionId}`,
            authenticatedActor: f.identity.userId,
            tenantId: f.tenantId,
          },
        )
      ).reason,
    ).toBe(failJournal ? 'error' : 'completed');
    expect(stream).toHaveBeenCalledTimes(failJournal ? 0 : 1);
  }
});

it('continues a partial response only on its original deployment', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const routes: string[] = [];
    const loop = new CoreAgentLoop({
      store: f.store,
      model: 'legacy/model',
      tools: new CoreToolRegistry(new FakeSandbox()),
      workspaceRoot: '/ws',
      routing: f.routing,
      now: () => Date.now(),
      wait: async (ms) => {
        vi.setSystemTime(Date.now() + ms);
      },
      llm: {
        stream: async (_request, route) => {
          routes.push(route!.receipt.deploymentId);
          const first = routes.length === 1;
          return (async function* () {
            if (first) {
              yield { kind: 'text-delta' as const, text: 'Partial answer' };
              throw Object.assign(new Error('interrupted'), { statusCode: 503 });
            }
            yield* textChunks('Continued answer');
          })();
        },
      },
    });
    expect(
      (
        await loop.run(
          f.sessionId,
          'hello',
          { emit: () => undefined },
          { actor: f.identity.userId, tenantId: f.tenantId },
        )
      ).reason,
    ).toBe('completed');
    expect(routes).toEqual([f.deployments[0]!.id, f.deployments[0]!.id]);
  } finally {
    vi.useRealTimers();
  }
});

it('creates independent SDK connections from resolved settings and redacts SDK failures without extra retries', async () => {
  const f = fixture();
  const calls: { origin: string; authorization: string | null; model: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.json()) as { model: string };
    calls.push({
      origin: new URL(request.url).origin,
      authorization: request.headers.get('authorization'),
      model: body.model,
    });
    return new Response(
      JSON.stringify({ error: { message: 'private prompt echo must be removed' } }),
      { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '2' } },
    );
  };
  const gateway = new AiSdkGateway(undefined, { providerFetch: transport });
  for (let index = 0; index < 2; index++) {
    const route = await f.routing.resolve(
      f.identity,
      { profileId: f.profile.id },
      f.request,
      index
        ? [
            {
              deploymentId: f.deployments[0]!.id,
              connectionId: f.connections[0]!.id,
              output: false,
            },
          ]
        : [],
    );
    route.credential = `synthetic-key-${index}`;
    try {
      for await (const chunk of await gateway.stream(
        { ...f.request, model: route.receipt.pricingKey },
        route,
      ))
        void chunk;
      throw new Error('Provider failure expected');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 503 });
      expect(JSON.stringify(error)).not.toContain('synthetic-key');
      expect((error as Error).message).not.toContain('private prompt');
      expect((error as Error).message).not.toContain('provider0.example');
    }
  }
  expect(calls).toEqual(
    [0, 1].map((index) => ({
      origin: `https://provider${index}.example`,
      authorization: `Bearer synthetic-key-${index}`,
      model: `model${index}`,
    })),
  );
});

it('does not include malformed infrastructure key material in startup errors', () => {
  try {
    infrastructureCredentials('v1', '{"v1":private-key-material}');
    throw new Error('Configuration rejection expected');
  } catch (error) {
    expect((error as Error).message).toBe('Invalid LLM credential encryption configuration');
  }
});

it('keeps tenant identities and arbitrary unpriced configuration strings out of metric labels', async () => {
  const f = fixture();
  f.deployments[0]!.pricingKey = 'private-tenant-config-value';
  const tokens = vi.spyOn(tokenCounter, 'add');
  const latency = vi.spyOn(modelLatency, 'record');
  try {
    const loop = new CoreAgentLoop({
      store: f.store,
      model: 'legacy/model',
      routing: f.routing,
      tools: new CoreToolRegistry(new FakeSandbox()),
      workspaceRoot: '/ws',
      llm: {
        stream: async () =>
          (async function* () {
            yield { kind: 'usage' as const, inputTokens: 1, outputTokens: 1 };
            yield* textChunks('OK');
          })(),
      },
    });
    expect(
      (
        await loop.run(
          f.sessionId,
          'hello',
          { emit: () => undefined },
          { actor: f.identity.userId, tenantId: f.tenantId },
        )
      ).reason,
    ).toBe('completed');
    const labels = JSON.stringify([...tokens.mock.calls, ...latency.mock.calls]);
    expect(labels).not.toContain(f.tenantId);
    expect(labels).not.toContain('private-tenant-config-value');
    expect(labels).toContain('unpriced');
  } finally {
    tokens.mockRestore();
    latency.mockRestore();
  }
});

it('uses published output/context and pricing for planning and admission instead of startup defaults', async () => {
  const f = fixture();
  f.user.role = 'expert';
  f.deployments[0]!.outputTokens = 20000;
  f.profile.maxOutputTokens = 15000;
  await f.store.append(f.sessionId, [
    {
      type: 'llm/settings',
      eventId: randomUUID(),
      at: new Date().toISOString(),
      operationId: randomUUID(),
      settings: { profileId: f.profile.id, maxOutputTokens: 12000 },
    },
  ]);
  const pricing = {
    [f.deployments[0]!.pricingKey]: [
      { currency: 'USD', version: 'fixed-catalog', input: '1', output: '1', minInputTokens: 0 },
    ],
  };
  const stream = vi.fn(async (request: LLMRequest) => {
    expect(request.model).toBe(f.deployments[0]!.pricingKey);
    expect(request.maxOutputTokens).toBe(12000);
    return (async function* () {
      yield { kind: 'usage' as const, inputTokens: 1, uncachedInputTokens: 1, outputTokens: 1 };
      yield* textChunks('OK');
    })();
  });
  const loop = new CoreAgentLoop({
    store: f.store,
    model: 'legacy/unpriced',
    maxOutputTokens: 512,
    maxContextTokens: 10000,
    routing: f.routing,
    pricing,
    execution: new EventTaskExecution(
      f.store,
      taskBudgetSchema.parse({ maxCost: [{ currency: 'USD', amount: '1' }] }),
      pricing,
    ),
    tools: new CoreToolRegistry(new FakeSandbox()),
    workspaceRoot: '/ws',
    llm: { stream },
  });
  expect(
    (
      await loop.run(
        f.sessionId,
        'hello',
        { emit: () => undefined },
        { actor: f.identity.userId, tenantId: f.tenantId },
      )
    ).reason,
  ).toBe('completed');
  expect(stream).toHaveBeenCalledTimes(1);
});

it('uses an approved backup for unavailable DNS but never bypasses an endpoint policy denial', async () => {
  for (const code of ['UNAVAILABLE', 'INVALID'] as const) {
    const f = fixture();
    f.policy.validate.mockImplementation(async (endpoint: string) => {
      if (endpoint === f.connections[0]!.endpoint)
        throw new LlmConfigurationError(code, 'Provider endpoint unavailable');
    });
    if (code === 'UNAVAILABLE')
      expect(
        (await f.routing.resolve(f.identity, { profileId: f.profile.id }, f.request, [])).receipt
          .deploymentId,
      ).toBe(f.deployments[1]!.id);
    else
      await expect(
        f.routing.resolve(f.identity, { profileId: f.profile.id }, f.request, []),
      ).rejects.toMatchObject({ code: 'INVALID' });
  }
});

it.each(['missing/model', 'constructor', '__proto__'])(
  'preserves unavailable pricing for catalog key %s',
  (key) => {
    expect(
      priceUsage(
        key,
        {
          inputTokens: 1,
          uncachedInputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
        },
        {},
      ),
    ).toEqual({});
  },
);

describe('direct model routing', () => {
  function direct() {
    const f = fixture();
    const first = { providerId: f.connections[0]!.id, modelId: f.deployments[0]!.modelId };
    const second = { providerId: f.connections[1]!.id, modelId: f.deployments[1]!.modelId };
    const configuration = llmConfigurationSchema.parse({
      ...f.configuration,
      profiles: [],
      defaultProfileId: '',
      routing: { defaultModel: first, automaticFallback: true, fallbackModels: [second] },
    });
    const state = { ...f.state, published: configuration, draft: configuration };
    f.updateState(state);
    return { ...f, state, first, second };
  }
  it('follows a changed default while explicit selections remain fixed', async () => {
    const f = direct();
    const initial = await f.routing.resolve(f.identity, { followDefault: true }, f.request, []);
    expect(initial.receipt.deploymentId).toBe(f.deployments[0]!.id);
    expect(initial.receipt.profileId).toBeUndefined();
    f.state.published!.routing!.defaultModel = f.second;
    f.state.published!.routing!.fallbackModels = [];
    f.state.activeRevision = 2;
    f.updateState(f.state);
    const following = await f.routing.resolve(f.identity, { followDefault: true }, f.request, []);
    const explicit = await f.routing.resolve(f.identity, { model: f.first }, f.request, []);
    expect(following.receipt.deploymentId).toBe(f.deployments[1]!.id);
    expect(explicit.receipt.deploymentId).toBe(f.deployments[0]!.id);
    expect(explicit.receipt.selection).toBe('model');
    await expect(f.routing.admit(f.identity, initial)).rejects.toThrow('Routing changed');
  });
  it('uses approved fallback and preserves partial-output deployment fencing', async () => {
    const f = direct();
    const failed = {
      deploymentId: f.deployments[0]!.id,
      connectionId: f.connections[0]!.id,
      output: false,
    };
    const backup = await f.routing.resolve(f.identity, { followDefault: true }, f.request, [
      failed,
    ]);
    expect(backup.receipt.reason).toBe('fallback');
    expect(backup.receipt.deploymentId).toBe(f.deployments[1]!.id);
    const partial = await f.routing.resolve(f.identity, { followDefault: true }, f.request, [
      { ...failed, output: true },
    ]);
    expect(partial.receipt.deploymentId).toBe(f.deployments[0]!.id);
    await expect(
      f.routing.resolve(f.identity, { followDefault: true, pinned: true }, f.request, []),
    ).rejects.toThrow('account role');
    f.user.role = 'expert';
    const pinned = await f.routing.resolve(
      f.identity,
      { followDefault: true, pinned: true },
      f.request,
      [failed],
    );
    expect(pinned.receipt.deploymentId).toBe(f.deployments[0]!.id);
    expect(pinned.receipt.automaticFallback).toBe(false);
  });
  it('persists a default-following binding and refuses ambiguous retired profiles', async () => {
    const f = direct();
    const scope = await f.routing.session(f.sessionId, f.user.id);
    expect(scope?.settings).toEqual({ followDefault: true });
    expect(
      (await f.store.load(f.sessionId)).find((row) => row.type === 'llm/settings'),
    ).toMatchObject({ settings: { followDefault: true } });
    await expect(
      f.routing.resolve(f.identity, { profileId: f.profile.id }, f.request, []),
    ).rejects.toThrow('Select a model');
  });
  it('binds an existing unselected conversation to the managed default without changing history', async () => {
    const f = direct();
    await f.store.append(f.sessionId, [
      {
        eventId: randomUUID(),
        at: new Date().toISOString(),
        type: 'model/usage',
        usage: {
          requestId: randomUUID(),
          promptId: randomUUID(),
          model: 'environment/model',
          purpose: 'assistant',
          tokens: { inputTokens: 2, outputTokens: 1 },
        },
      },
    ]);
    const original = await f.store.load(f.sessionId);
    const scope = await f.routing.session(f.sessionId, f.user.id);
    expect(scope?.settings).toEqual({ followDefault: true });
    const route = await f.routing.resolve(scope!.identity, scope!.settings, f.request, []);
    expect(route.receipt.deploymentId).toBe(f.deployments[0]!.id);
    await f.routing.admit(scope!.identity, route);
    const events = await f.store.load(f.sessionId);
    expect(events.slice(0, original.length)).toEqual(original);
    expect(events.at(-1)).toMatchObject({
      type: 'llm/settings',
      settings: { followDefault: true },
    });
    await f.routing.session(f.sessionId, f.user.id);
    expect(await f.store.load(f.sessionId)).toEqual(events);
  });
  it('retains explicit and legacy profile bindings instead of silently choosing the default', async () => {
    const f = direct();
    await f.store.append(f.sessionId, [
      {
        eventId: randomUUID(),
        at: new Date().toISOString(),
        type: 'session/created',
        workspaceUri: '/ws',
        kind: 'chat',
        llmProfileId: f.profile.id,
      },
    ]);
    const original = await f.store.load(f.sessionId);
    const legacy = await f.routing.session(f.sessionId, f.user.id);
    expect(legacy?.settings).toEqual({ profileId: f.profile.id });
    await expect(
      f.routing.resolve(legacy!.identity, legacy!.settings, f.request, []),
    ).rejects.toThrow('Select a model');
    expect(await f.store.load(f.sessionId)).toEqual(original);
    await f.store.append(f.sessionId, [
      {
        eventId: randomUUID(),
        at: new Date().toISOString(),
        type: 'llm/settings',
        operationId: randomUUID(),
        settings: { model: f.second },
      },
    ]);
    expect((await f.routing.session(f.sessionId, f.user.id))?.settings).toEqual({
      model: f.second,
    });
  });
  it('does not restore environment routing when the managed default is missing', async () => {
    const f = direct();
    f.state.published!.routing!.defaultModel = null;
    f.state.published!.routing!.fallbackModels = [];
    f.state.published!.routing!.automaticFallback = false;
    f.updateState(f.state);
    const scope = await f.routing.session(f.sessionId, f.user.id);
    expect(scope?.settings).toEqual({ followDefault: true });
    await expect(
      f.routing.resolve(scope!.identity, scope!.settings, f.request, []),
    ).rejects.toThrow('Select an available default model');
  });
  it('rejects duplicate, disabled and missing routing references', () => {
    const f = direct();
    const config = f.state.published!;
    expect(
      llmConfigurationSchema.safeParse({
        ...config,
        routing: { ...config.routing, fallbackModels: [f.first] },
      }).success,
    ).toBe(false);
    expect(
      llmConfigurationSchema.safeParse({
        ...config,
        routing: {
          ...config.routing,
          defaultModel: { providerId: randomUUID(), modelId: 'unknown' },
        },
      }).success,
    ).toBe(false);
  });
});
