import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  llmSessionSettingsWriteSchema,
  llmProbeRequestSchema,
  hasLlmSessionOverrides,
  hasCapability,
  LlmConfigurationError,
  llmConfigurationSaveSchema,
  llmConfigurationPublishSchema,
  llmCredentialWriteSchema,
  type Identity,
  type LlmConfigurationPort,
  type LlmCredentialPort,
  type LlmEndpointPolicyPort,
  type SessionStore,
  type LlmProviderOperationsPort,
  type LLMPort,
  type LlmProbeResult,
  type ModelPricing,
  type TokenUsage,
} from '@trinity-harness/contracts';
import { normalizeTokenUsage, priceUsage } from '@trinity-harness/core';
import { sumTokenUsage, newId } from '@trinity-harness/shared';

export interface LlmApiDependencies {
  operations?: LlmProviderOperationsPort | undefined;
  gateway?: LLMPort | undefined;
  pricing?: ModelPricing | undefined;
  configuration?: LlmConfigurationPort | undefined;
  credentials?: LlmCredentialPort | undefined;
  endpointPolicy?: LlmEndpointPolicyPort | undefined;
  store: SessionStore;
  authorizeSession: (
    sessionId: string,
    identity: Identity,
    reply: FastifyReply,
  ) => Promise<unknown>;
}
/** Independent server enforcement. No frontend role/hidden-control trust. */
export function registerLlmConfigurationApi(app: FastifyInstance, deps: LlmApiDependencies): void {
  const admin = (identity: Identity | undefined): Identity => {
    if (!identity || !hasCapability(identity.role, 'llm.configuration.manage'))
      throw new LlmConfigurationError('FORBIDDEN', 'Admin required');
    if (!deps.configuration || !deps.credentials || !deps.endpointPolicy)
      throw new LlmConfigurationError('UNAVAILABLE', 'Provider management unavailable');
    return identity;
  };
  const handle = async (reply: FastifyReply, action: () => Promise<unknown>): Promise<unknown> => {
    reply.header('cache-control', 'private, no-store');
    try {
      return await action();
    } catch (error) {
      if (error instanceof LlmConfigurationError) {
        const status = {
          FORBIDDEN: 403,
          CONFLICT: 409,
          UNAVAILABLE: 503,
          INVALID: 400,
          MIGRATION_REQUIRED: 409,
          STALE_OVERRIDE: 409,
        }[error.code];
        return reply.code(status).send({ error: error.message, code: error.code });
      }
      if (error instanceof z.ZodError)
        return reply.code(400).send({ error: 'Invalid configuration request' });
      if ((error as { code?: string }).code === 'SESSION_CONFLICT')
        return reply
          .code(409)
          .send({ error: 'Conversation changed; reload session settings and retry' });
      // Do not serialize credentials, SDK request bodies or endpoint responses.
      return reply.code(503).send({ error: 'Provider configuration operation unavailable' });
    }
  };
  const params = z.object({ id: z.uuid() });
  app.get('/api/admin/llm/configuration', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      return deps.configuration!.read(identity.tenantId);
    }),
  );
  app.get('/api/admin/llm/configuration/impact/:version', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      const { version } = z
        .object({ version: z.coerce.number().int().nonnegative() })
        .parse(req.params);
      return deps.configuration!.impact(identity.tenantId, version);
    }),
  );
  app.get('/api/admin/llm/revisions/:revision', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      const { revision } = z
        .object({ revision: z.coerce.number().int().positive() })
        .parse(req.params);
      const configuration = await deps.configuration!.revision(identity.tenantId, revision);
      if (!configuration) throw new LlmConfigurationError('INVALID', 'Unknown revision');
      return configuration;
    }),
  );
  app.put('/api/admin/llm/configuration', { bodyLimit: 600_000 }, (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      const input = llmConfigurationSaveSchema.parse(req.body);
      for (const connection of input.configuration.connections)
        deps.endpointPolicy!.validateConfiguration(connection.endpoint);
      return deps.configuration!.save(identity, input);
    }),
  );
  for (const action of ['publish', 'rollback'] as const)
    app.post(`/api/admin/llm/configuration/${action}`, (req, reply) =>
      handle(reply, async () => {
        const identity = admin(req.identity);
        const input = llmConfigurationPublishSchema.parse(req.body);
        if ((action === 'rollback') !== (input.restoreRevision !== undefined))
          throw new LlmConfigurationError('INVALID', 'Specify a revision only for rollback');
        // Rollback also passes current operator endpoint policy at dispatch; revoked
        // credentials are checked transactionally by the store and never restored.
        const state = await deps.configuration!.read(identity.tenantId);
        const target = input.restoreRevision
          ? await deps.configuration!.revision(identity.tenantId, input.restoreRevision)
          : state.draft;
        if (!target)
          throw new LlmConfigurationError('INVALID', 'Configuration revision unavailable');
        for (const connection of target.connections)
          deps.endpointPolicy!.validateConfiguration(connection.endpoint);
        return deps.configuration!.publish(identity, input);
      }),
    );
  app.put('/api/admin/llm/connections/:id/credentials', { bodyLimit: 100_000 }, (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      const { id } = params.parse(req.params);
      const input = llmCredentialWriteSchema.parse(req.body);
      const sealed = await deps.credentials!.seal(
        identity.tenantId,
        id,
        input.operationId,
        input.secret,
      );
      return deps.configuration!.replaceCredential(
        identity,
        id,
        { expectedVersion: input.expectedVersion, operationId: input.operationId },
        sealed,
      );
    }),
  );
  app.delete('/api/admin/llm/connections/:id/credentials', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      const { id } = params.parse(req.params);
      const input = llmCredentialWriteSchema.omit({ secret: true }).parse(req.body);
      return deps.configuration!.revokeCredential(identity, id, input);
    }),
  );
  app.post('/api/admin/llm/connections/:id/test', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      if (!deps.operations || !deps.gateway)
        throw new LlmConfigurationError('UNAVAILABLE', 'Synthetic tests unavailable');
      const { id } = params.parse(req.params);
      const input = llmProbeRequestSchema.parse(req.body);
      const state = await deps.configuration!.read(identity.tenantId);
      const connection = state.draft?.connections.find((row) => row.id === id && row.enabled);
      const deployment = state.draft?.deployments.find(
        (row) => row.id === input.deploymentId && row.connectionId === id && row.enabled,
      );
      const key = state.credentials.find((row) => row.connectionId === id && !row.revoked);
      if (!connection || !deployment || !key)
        throw new LlmConfigurationError(
          'INVALID',
          'Enabled draft deployment and current key required',
        );
      deps.endpointPolicy!.validateConfiguration(connection.endpoint);
      const cooldown = await deps.operations.cooldown(
        identity.tenantId,
        connection.id,
        deployment.id,
      );
      if (cooldown)
        throw new LlmConfigurationError(
          'UNAVAILABLE',
          `Provider cooldown is active until ${cooldown}; test again afterward`,
        );
      const lease = await deps.operations.beginProbe(
        identity,
        input.operationId,
        id,
        deployment.id,
        input.expectedVersion,
      );
      if (!lease.admitted) return lease.result;
      const result: LlmProbeResult = { ...lease.result, status: 'failed' };
      const samples: TokenUsage[] = [];
      let dispatched = false;
      const controller = new AbortController();
      const probeSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      const abort = (): void => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      req.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      if (req.raw.aborted || reply.raw.destroyed) controller.abort();
      try {
        probeSignal.throwIfAborted();
        await deps.endpointPolicy!.validate(connection.endpoint, probeSignal);
        const sealed = await deps.configuration!.credential(identity.tenantId, id, key.versionId);
        if (!sealed) throw new LlmConfigurationError('UNAVAILABLE', 'Credential unavailable');
        const credential = await deps.credentials!.open(
          identity.tenantId,
          id,
          key.versionId,
          sealed,
        );
        const latest = await deps.configuration!.read(identity.tenantId);
        if (latest.version !== input.expectedVersion)
          throw new LlmConfigurationError(
            'CONFLICT',
            'Configuration changed before synthetic test',
          );
        probeSignal.throwIfAborted();
        dispatched = true;
        const stream = await deps.gateway.stream(
          {
            model: deployment.pricingKey,
            messages: [
              { role: 'user', content: 'Reply with OK. This is a synthetic connection test.' },
            ],
            tools: [],
            maxOutputTokens: Math.min(128, deployment.outputTokens),
            signal: probeSignal,
          },
          {
            receipt: {
              revision: state.version,
              profileId: state.draft!.defaultProfileId,
              connectionId: id,
              deploymentId: deployment.id,
              credentialVersionId: key.versionId,
              modelId: deployment.modelId,
              pricingKey: deployment.pricingKey,
              reason: 'primary',
              maxOutputTokens: Math.min(128, deployment.outputTokens),
            },
            connection,
            deployment,
            credential,
          },
        );
        for await (const chunk of stream) {
          if (chunk.kind === 'usage') {
            samples.push(chunk);
            if (chunk.inputTokens !== undefined) result.inputTokens = chunk.inputTokens;
            if (chunk.outputTokens !== undefined) result.outputTokens = chunk.outputTokens;
          }
          if (chunk.kind === 'finish' && chunk.reason === 'stop') result.status = 'passed';
        }
        if (result.status === 'passed') {
          const current = await deps.configuration!.read(identity.tenantId);
          // A draft-only change must never restore the circuit for different published settings.
          if (
            current.version === state.version &&
            JSON.stringify(
              current.published?.deployments.find((row) => row.id === deployment.id),
            ) === JSON.stringify(deployment) &&
            JSON.stringify(current.published?.connections.find((row) => row.id === id)) ===
              JSON.stringify(connection)
          )
            await deps.operations.restore(identity.tenantId, deployment.id, key.versionId);
        }
      } catch {
        result.status =
          dispatched && result.inputTokens === undefined && result.outputTokens === undefined
            ? 'unknown'
            : 'failed';
      } finally {
        req.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abort);
        if (!dispatched) {
          result.inputTokens = 0;
          result.outputTokens = 0;
        }
        result.tokens = normalizeTokenUsage(
          !dispatched ? { inputTokens: 0, outputTokens: 0 } : sumTokenUsage(samples),
        );
        if (result.tokens.inputTokens !== undefined) result.inputTokens = result.tokens.inputTokens;
        if (result.tokens.outputTokens !== undefined)
          result.outputTokens = result.tokens.outputTokens;
        result.pricingKey = deployment.pricingKey;
        Object.assign(result, priceUsage(deployment.pricingKey, result.tokens, deps.pricing ?? {}));
        await deps.operations.finishProbe(identity.tenantId, result);
      }
      return result;
    }),
  );
  app.get('/api/admin/llm/health', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      if (!deps.operations)
        throw new LlmConfigurationError('UNAVAILABLE', 'Shared provider health unavailable');
      return { health: await deps.operations.health(identity.tenantId) };
    }),
  );
  app.get('/api/admin/llm/tests', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      if (!deps.operations)
        throw new LlmConfigurationError('UNAVAILABLE', 'Test history unavailable');
      return { tests: await deps.operations.probes(identity.tenantId) };
    }),
  );
  app.get('/api/admin/llm/activity', (req, reply) =>
    handle(reply, async () => {
      const identity = admin(req.identity);
      return { activity: await deps.configuration!.activity(identity.tenantId) };
    }),
  );
  app.get('/api/llm/profiles', (req, reply) =>
    handle(reply, async () => {
      if (!req.identity || !deps.configuration) return { available: false, profiles: [] };
      const state = await deps.configuration.read(req.identity.tenantId);
      const config = state.published;
      if (!config) return { available: false, profiles: [] };
      return {
        available: true,
        defaultProfileId: config.defaultProfileId,
        canTune: hasCapability(req.identity.role, 'llm.session.tune'),
        profiles: config.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          mode: profile.mode,
          maxOutputTokens: profile.maxOutputTokens,
          reasoningEfforts: profile.reasoningEfforts,
          maxReasoningTokens: profile.maxReasoningTokens,
          ...(hasCapability(req.identity!.role, 'llm.session.tune')
            ? {
                backups: profile.backups,
                deployments: config.deployments
                  .filter((row) => profile.allowedDeployments.includes(row.id))
                  .map((row) => ({ id: row.id, name: row.name })),
              }
            : {}),
        })),
      };
    }),
  );
  app.get('/api/sessions/:id/llm-settings', (req, reply) =>
    handle(reply, async () => {
      if (!req.identity) throw new LlmConfigurationError('FORBIDDEN', 'Authentication required');
      const { id } = params.parse(req.params);
      if (!(await deps.authorizeSession(id, req.identity, reply))) return;
      const events = await deps.store.load(id);
      const selection = events.findLast((event) => event.type === 'llm/settings');
      const creation = events.find((event) => event.type === 'session/created');
      return {
        expectedLastSeq: events.length,
        settings:
          selection?.type === 'llm/settings'
            ? selection.settings
            : creation?.type === 'session/created' && creation.llmProfileId
              ? { profileId: creation.llmProfileId }
              : null,
      };
    }),
  );
  app.put('/api/sessions/:id/llm-settings', (req, reply) =>
    handle(reply, async () => {
      const identity = req.identity;
      if (!identity || !hasCapability(identity.role, 'llm.profile.select'))
        throw new LlmConfigurationError('FORBIDDEN', 'Profile selection unavailable for this role');
      const { id } = params.parse(req.params);
      if (!(await deps.authorizeSession(id, identity, reply))) return;
      if (!deps.configuration)
        throw new LlmConfigurationError('UNAVAILABLE', 'Provider configuration unavailable');
      const input = llmSessionSettingsWriteSchema.parse(req.body);
      const state = await deps.configuration.read(identity.tenantId);
      const profile = state.published?.profiles.find((row) => row.id === input.settings.profileId);
      if (!profile) throw new LlmConfigurationError('INVALID', 'Select a published profile');
      const settings = input.settings;
      if (hasLlmSessionOverrides(settings) && !hasCapability(identity.role, 'llm.session.tune'))
        throw new LlmConfigurationError('FORBIDDEN', 'Expert role required for advanced settings');
      if (
        (settings.maxOutputTokens ?? 0) > profile.maxOutputTokens ||
        (settings.pinnedDeploymentId &&
          !profile.allowedDeployments.includes(settings.pinnedDeploymentId)) ||
        settings.backups?.some((target) => !profile.backups.includes(target)) ||
        new Set(settings.backups).size !== (settings.backups?.length ?? 0)
      )
        throw new LlmConfigurationError('INVALID', 'Settings exceed published profile permissions');
      if (
        (settings.reasoningEffort &&
          !profile.reasoningEfforts?.includes(settings.reasoningEffort)) ||
        (settings.reasoningBudgetTokens &&
          settings.reasoningBudgetTokens > (profile.maxReasoningTokens ?? 0))
      )
        throw new LlmConfigurationError('INVALID', 'Reasoning settings exceed published bounds');
      const events = await deps.store.load(id);
      const previous = events.find(
        (event) => event.type === 'llm/settings' && event.operationId === input.operationId,
      );
      if (previous?.type === 'llm/settings') {
        if (JSON.stringify(previous.settings) !== JSON.stringify(settings))
          throw new LlmConfigurationError('CONFLICT', 'Operation identifier reused');
        return { ok: true };
      }
      await deps.store.append(
        id,
        [
          {
            eventId: newId(),
            at: new Date().toISOString(),
            type: 'llm/settings',
            operationId: input.operationId,
            settings,
          },
        ],
        { actor: identity.userId, expectedLastSeq: input.expectedLastSeq },
      );
      return { ok: true };
    }),
  );
}
