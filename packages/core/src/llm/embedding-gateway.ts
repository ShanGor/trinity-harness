import './provider-log-policy.js';
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';
import { z } from 'zod';
import {
  windowStart,
  type EmbeddingPort,
  type LlmConfigurationPort,
  type LlmCredentialPort,
  type LlmEndpointPolicyPort,
  type SessionStore,
  type SessionMetaStore,
  type UsagePort,
  type UserStore,
  type ModelPricing,
  type ModelUsage,
} from '@trinity-harness/contracts';
import { priceUsage } from './usage.js';

/** Embeddings share tenant credentials, constrained SDK transport, durable usage and quotas. */
export class AiSdkEmbeddingGateway implements EmbeddingPort {
  constructor(
    readonly model: string,
    private readonly deps: {
      configuration: LlmConfigurationPort;
      credentials: LlmCredentialPort;
      policy: LlmEndpointPolicyPort;
      store: SessionStore;
      metas: Pick<SessionMetaStore, 'get'>;
      usage: UsagePort;
      users: Pick<UserStore, 'findById'>;
      pricing: ModelPricing;
    },
  ) {}
  async embed(
    texts: string[],
    context: Parameters<EmbeddingPort['embed']>[1],
  ): ReturnType<EmbeddingPort['embed']> {
    const values = z.array(z.string().min(1).max(10001)).min(1).max(20).parse(texts);
    const signal = AbortSignal.any([
      ...(context.signal ? [context.signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    const { owner, sessionId, promptId } = context;
    const user = await this.deps.users.findById(owner.userId);
    const meta = await this.deps.metas.get(sessionId);
    if (
      !user ||
      user.tenantId !== owner.tenantId ||
      user.role === 'viewer' ||
      !meta ||
      meta.closedAt ||
      meta.scope !== 'personal' ||
      meta.tenantId !== owner.tenantId ||
      meta.userId !== owner.userId
    )
      throw new Error('Embedding authorization unavailable');
    const quota = await this.deps.usage.quotaOf(owner.tenantId);
    for (const [window, field] of [
      ['hour', 'hourlyTokens'],
      ['day', 'dailyTokens'],
      ['month', 'monthlyTokens'],
    ] as const) {
      const limit = quota[field];
      if (
        limit !== undefined &&
        (await this.deps.usage.usageSince(owner.tenantId, windowStart(window, new Date()))) >= limit
      )
        throw new Error('Embedding quota exceeded');
    }
    const split = this.model.indexOf('/');
    const provider = this.model.slice(0, split);
    const modelId = this.model.slice(split + 1);
    const state = await this.deps.configuration.read(owner.tenantId);
    let apiKey: string | undefined;
    let baseURL: string | undefined;
    if (state.source === 'database') {
      const matches =
        state.published?.connections.filter((c) => c.id === provider || c.name === provider) ?? [];
      const connection = matches.length === 1 ? matches[0] : undefined;
      const deployment = state.published?.deployments.find(
        (d) => d.connectionId === connection?.id && d.modelId === modelId && d.enabled,
      );
      const key = state.credentials.find((c) => c.connectionId === connection?.id && !c.revoked);
      if (
        !state.activeRevision ||
        !connection?.enabled ||
        connection.adapter !== 'openai' ||
        !deployment ||
        !key
      )
        throw new Error('Configured embedding provider unavailable');
      const sealed = await this.deps.configuration.credential(
        owner.tenantId,
        connection.id,
        key.versionId,
      );
      if (!sealed) throw new Error('Embedding credential unavailable');
      apiKey = await this.deps.credentials.open(
        owner.tenantId,
        connection.id,
        key.versionId,
        sealed,
      );
      baseURL = connection.endpoint;
    } else {
      if (provider !== 'openai') throw new Error('Unsupported embedding provider');
      apiKey = process.env['OPENAI_API_KEY'];
      baseURL = process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1';
      if (!apiKey) throw new Error('Embedding credential unavailable');
    }
    await this.deps.policy.validate(baseURL, signal);
    const currentUser = await this.deps.users.findById(owner.userId);
    const currentMeta = await this.deps.metas.get(sessionId);
    if (
      !currentUser ||
      currentUser.tenantId !== owner.tenantId ||
      currentUser.role === 'viewer' ||
      !currentMeta ||
      currentMeta.closedAt ||
      currentMeta.scope !== 'personal' ||
      currentMeta.tenantId !== owner.tenantId ||
      currentMeta.userId !== owner.userId
    )
      throw new Error('Embedding authorization changed');
    await context.beforeDispatch?.();
    const request = {
      model: this.model,
      messages: values.map((content) => ({ role: 'user' as const, content })),
      tools: [],
      maxOutputTokens: 0,
      signal,
    };
    const requestId = context.taskBudget
      ? await context.taskBudget.admit(request, 'memory-embedding', 'work')
      : randomUUID();
    const started = Date.now();
    try {
      const result = await embedMany({
        model: createOpenAI({ apiKey, baseURL, fetch: this.deps.policy.fetch }).embeddingModel(
          modelId,
        ),
        values,
        maxRetries: 0,
        maxParallelCalls: 1,
        abortSignal: signal,
      });
      const vectors = z
        .array(z.array(z.number().finite()).min(1).max(16000))
        .length(values.length)
        .parse(result.embeddings);
      const dimensions = vectors[0]!.length;
      if (vectors.some((v) => v.length !== dimensions || !v.some((n) => n !== 0)))
        throw new Error('Invalid embedding result');
      const tokens = {
        inputTokens: result.usage.tokens,
        uncachedInputTokens: result.usage.tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const usage: ModelUsage = {
        requestId,
        promptId,
        model: this.model,
        purpose: 'memory-embedding',
        durationMs: Date.now() - started,
        tokens,
        ...priceUsage(this.model, tokens, this.deps.pricing),
      };
      await context.taskBudget?.record(usage);
      if (
        !(await this.deps.store.load(sessionId)).some(
          (e) => e.type === 'model/usage' && e.usage.requestId === requestId,
        )
      )
        await this.deps.store.append(sessionId, [
          { type: 'model/usage', eventId: randomUUID(), at: new Date().toISOString(), usage },
        ]);
      await this.deps.usage.record({
        tenantId: owner.tenantId,
        sessionId,
        model: this.model,
        inputTokens: result.usage.tokens,
        outputTokens: 0,
      });
      return { vectors, model: this.model, dimensions };
    } catch {
      signal.throwIfAborted();
      throw new Error('Embedding request unavailable');
    }
  }
}
