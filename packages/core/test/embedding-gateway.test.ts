import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  LlmConfigurationPort,
  LlmCredentialPort,
  LlmEndpointPolicyPort,
  SessionMetaStore,
  UserStore,
  UsagePort,
} from '@trinity-harness/contracts';
import { AiSdkEmbeddingGateway, MemorySessionStore } from '../src/index.js';

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv('OPENAI_API_KEY', 'test-embedding-key');
  vi.stubEnv('OPENAI_BASE_URL', 'https://example.test/v1');
  const owner = { userId: randomUUID(), tenantId: randomUUID(), role: 'member' as const };
  const sessionId = randomUUID();
  const promptId = randomUUID();
  const store = new MemorySessionStore();
  const transport = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          model: 'embedding',
          data: [{ object: 'embedding', index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const policy: LlmEndpointPolicyPort = {
    validate: vi.fn(async () => undefined),
    validateConfiguration: vi.fn(),
    fetch: transport,
  };
  const usage: UsagePort = {
    quotaOf: vi.fn(async () => ({})),
    usageSince: vi.fn(async () => 0),
    record: vi.fn(),
  };
  const configuration = {
    read: vi.fn(async () => ({ source: 'environment' })),
  } as unknown as LlmConfigurationPort;
  const deps = {
    configuration,
    credentials: { open: vi.fn(), seal: vi.fn() } as LlmCredentialPort,
    policy,
    store,
    usage,
    metas: {
      get: async () => ({
        id: sessionId,
        userId: owner.userId,
        tenantId: owner.tenantId,
        scope: 'personal',
        title: 'test',
        workspaceUri: null,
        createdAt: new Date().toISOString(),
      }),
    } as Pick<SessionMetaStore, 'get'>,
    users: {
      findById: async () => ({
        id: owner.userId,
        tenantId: owner.tenantId,
        role: 'member',
        email: 'test@example.test',
        createdAt: new Date().toISOString(),
      }),
    } as Pick<UserStore, 'findById'>,
    pricing: {},
  };
  return {
    deps,
    owner,
    sessionId,
    promptId,
    transport,
    gateway: new AiSdkEmbeddingGateway('openai/embedding', deps),
  };
}
it('uses SDK transport with no retries and appends replayable embedding usage with unavailable prices', async () => {
  const f = fixture();
  const result = await f.gateway.embed(['I prefer tea.'], {
    purpose: 'memory-embedding',
    owner: f.owner,
    sessionId: f.sessionId,
    promptId: f.promptId,
  });
  expect(result).toEqual({ model: 'openai/embedding', dimensions: 2, vectors: [[1, 0]] });
  const logs = await f.deps.store.load(f.sessionId);
  expect(logs).toMatchObject([
    {
      type: 'model/usage',
      usage: {
        promptId: f.promptId,
        purpose: 'memory-embedding',
        tokens: { inputTokens: 3, outputTokens: 0 },
      },
    },
  ]);
  expect(JSON.stringify(logs)).not.toContain('test-embedding-key');
  expect(logs[0]?.type === 'model/usage' && logs[0].usage.cost).toBeUndefined();
  expect(f.deps.usage.record).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: f.owner.tenantId, inputTokens: 3 }),
  );
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it('fails closed on quota reads and fresh source revalidation before sending texts', async () => {
  const f = fixture();
  vi.mocked(f.deps.usage.quotaOf).mockRejectedValueOnce(new Error('offline'));
  await expect(
    f.gateway.embed(['private'], {
      purpose: 'memory-embedding',
      owner: f.owner,
      sessionId: f.sessionId,
      promptId: f.promptId,
    }),
  ).rejects.toThrow();
  await expect(
    f.gateway.embed(['private'], {
      purpose: 'memory-embedding',
      owner: f.owner,
      sessionId: f.sessionId,
      promptId: f.promptId,
      beforeDispatch: async () => {
        throw new Error('source excluded');
      },
    }),
  ).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
});
it('never falls back to an environment credential after database configuration activation', async () => {
  const f = fixture();
  vi.mocked(f.deps.configuration.read).mockResolvedValue({
    source: 'database',
    activeRevision: 1,
    version: 1,
    draft: null,
    published: null,
    credentials: [],
  });
  await expect(
    f.gateway.embed(['private'], {
      purpose: 'memory-embedding',
      owner: f.owner,
      sessionId: f.sessionId,
      promptId: f.promptId,
    }),
  ).rejects.toThrow('provider unavailable');
  expect(f.transport).not.toHaveBeenCalled();
});
