import {
  hasLlmSessionOverrides,
  llmSelectionPolicy,
  hasCapability,
  LlmConfigurationError,
  type LlmConfigurationPort,
  type LlmCredentialPort,
  type LlmEndpointPolicyPort,
  type LlmRoutingPort,
  type LlmResolvedRoute,
  type LlmSessionSettings,
  type Identity,
  type LlmRoutingLimits,
  type LlmCooldown,
  type LlmProviderOperationsPort,
  type LlmRouteAttempt,
  type LLMRequest,
  type UserStore,
  type SessionStore,
  type SessionMetaStore,
  type TeamStore,
} from '@trinity-harness/contracts';
import { newId } from '@trinity-harness/shared';
import { estimateRequestTokens } from '../context/estimate-tokens.js';

export class TenantLlmRouting implements LlmRoutingPort {
  constructor(
    private readonly configs: LlmConfigurationPort,
    private readonly credentials: LlmCredentialPort,
    private readonly policy: LlmEndpointPolicyPort,
    private readonly users: UserStore,
    private readonly store: SessionStore,
    private readonly metas: SessionMetaStore,
    private readonly teams?: TeamStore,
    private readonly operations?: LlmProviderOperationsPort,
    private readonly now: () => number = Date.now,
  ) {}
  private async current(identity: Identity): Promise<Identity> {
    const user = await this.users.findById(identity.userId);
    if (!user || user.tenantId !== identity.tenantId || !hasCapability(user.role, 'assistant.run'))
      throw new LlmConfigurationError('FORBIDDEN', 'Execution access revoked');
    return { ...identity, role: user.role };
  }
  async session(
    sessionId: string,
    actor: string,
    inheritedDepth = 0,
  ): Promise<{ identity: Identity; settings: LlmSessionSettings } | null> {
    if (inheritedDepth > 8)
      throw new LlmConfigurationError(
        'UNAVAILABLE',
        'Routing origin chain exceeds supported depth',
      );
    const meta = await this.metas.get(sessionId);
    const user = await this.users.findById(actor);
    if (
      !meta ||
      meta.closedAt ||
      !user ||
      user.tenantId !== meta.tenantId ||
      !hasCapability(user.role, 'assistant.run')
    )
      throw new LlmConfigurationError('FORBIDDEN', 'Execution access revoked');
    if (
      meta.scope === 'team'
        ? !meta.scopeId || !this.teams || !(await this.teams.isMember(meta.scopeId, actor))
        : meta.userId !== actor && user.role !== 'admin'
    )
      throw new LlmConfigurationError('FORBIDDEN', 'Session access revoked');
    const state = await this.configs.read(user.tenantId);
    if (state.source === 'environment') return null;
    const events = await this.store.load(sessionId);
    const selected = events.findLast((event) => event.type === 'llm/settings');
    const identity: Identity = { userId: user.id, tenantId: user.tenantId, role: user.role };
    if (selected?.type === 'llm/settings') return { identity, settings: selected.settings };
    const creation = events.find((event) => event.type === 'session/created');
    if (creation?.type === 'session/created' && creation.llmProfileId)
      return { identity, settings: { profileId: creation.llmProfileId } };
    if (
      creation?.type === 'session/created' &&
      creation.kind === 'work' &&
      creation.originSessionId
    ) {
      const origin = await this.metas.get(creation.originSessionId);
      if (
        !origin ||
        origin.closedAt ||
        origin.tenantId !== user.tenantId ||
        origin.userId !== meta.userId
      )
        throw new LlmConfigurationError('FORBIDDEN', 'Originating routing scope unavailable');
      const inherited = await this.session(origin.id, actor, inheritedDepth + 1);
      if (inherited) {
        await this.store.append(
          sessionId,
          [
            {
              eventId: newId(),
              at: new Date().toISOString(),
              type: 'llm/settings',
              operationId: newId(),
              settings: inherited.settings,
            },
          ],
          { actor, expectedLastSeq: events.length },
        );
        return inherited;
      }
    }
    // Usage history is not an explicit routing choice. Unbound conversations
    // follow the managed default just like new ones after direct routing activates.
    if (!state.published?.routing && events.some((event) => event.type === 'model/usage'))
      throw new LlmConfigurationError(
        'MIGRATION_REQUIRED',
        'Select an enabled model for this existing conversation before continuing',
      );
    if (!state.published)
      throw new LlmConfigurationError('UNAVAILABLE', 'Published configuration missing');
    const settings: LlmSessionSettings = state.published.routing
      ? { followDefault: true }
      : { profileId: state.published.defaultProfileId };
    await this.store.append(
      sessionId,
      [
        {
          eventId: newId(),
          at: new Date().toISOString(),
          type: 'llm/settings',
          operationId: newId(),
          settings,
        },
      ],
      { actor, expectedLastSeq: events.length },
    );
    return { identity, settings };
  }
  /** Configuration values for planning, never authorization to dispatch. */
  async limits(sessionId: string, actor: string): Promise<LlmRoutingLimits | null> {
    const scope = await this.session(sessionId, actor);
    if (!scope) return null;
    const state = await this.configs.read(scope.identity.tenantId);
    const profile = state.published && llmSelectionPolicy(state.published, scope.settings);
    if (!profile)
      throw new LlmConfigurationError(
        'UNAVAILABLE',
        'Profile unavailable; select an approved profile',
      );
    if (
      hasLlmSessionOverrides(scope.settings) &&
      !hasCapability(scope.identity.role, 'llm.session.tune')
    )
      throw new LlmConfigurationError(
        'STALE_OVERRIDE',
        'Reset advanced settings after account role change',
      );
    if (scope.settings.maxOutputTokens && scope.settings.maxOutputTokens > profile.maxOutputTokens)
      throw new LlmConfigurationError(
        'STALE_OVERRIDE',
        'Output setting exceeds current profile bounds; reset settings',
      );
    const candidates = scope.settings.pinnedDeploymentId
      ? [scope.settings.pinnedDeploymentId]
      : [
          profile.primary,
          ...(profile.mode === 'automatic' ? (scope.settings.backups ?? profile.backups) : []),
        ];
    for (const id of candidates) {
      if (!profile.allowedDeployments.includes(id)) continue;
      const deployment = state.published!.deployments.find((row) => row.id === id && row.enabled);
      const connection =
        deployment &&
        state.published!.connections.find(
          (row) => row.id === deployment.connectionId && row.enabled,
        );
      const key =
        connection &&
        state.credentials.find((row) => row.connectionId === connection.id && !row.revoked);
      if (!deployment || !connection || !key) continue;
      if (profile.mode === 'automatic' && !scope.settings.pinnedDeploymentId) {
        if (!this.operations)
          throw new LlmConfigurationError('UNAVAILABLE', 'Shared provider health unavailable');
        if (await this.operations.blocked(scope.identity.tenantId, id, key.versionId)) continue;
      }
      return {
        model: deployment.pricingKey,
        contextTokens: deployment.contextTokens,
        outputTokens: Math.min(
          deployment.outputTokens,
          scope.settings.maxOutputTokens ?? profile.maxOutputTokens,
        ),
      };
    }
    throw new LlmConfigurationError(
      'UNAVAILABLE',
      'No approved deployment is available; contact an Admin',
    );
  }
  async resolve(
    identity: Identity,
    settings: LlmSessionSettings,
    request: LLMRequest,
    attempted: LlmRouteAttempt[],
    historyDeploymentId?: string,
  ): Promise<LlmResolvedRoute> {
    const current = await this.current(identity);
    const state = await this.configs.read(identity.tenantId);
    const config = state.published;
    if (state.source !== 'database' || !config || !state.activeRevision)
      throw new LlmConfigurationError('UNAVAILABLE', 'Published routing unavailable');
    const profile = llmSelectionPolicy(config, settings);
    if (!profile)
      throw new LlmConfigurationError(
        'UNAVAILABLE',
        'Profile retired; select another approved profile',
      );
    if (hasLlmSessionOverrides(settings) && !hasCapability(current.role, 'llm.session.tune'))
      throw new LlmConfigurationError(
        'STALE_OVERRIDE',
        'Reset advanced settings after account role change',
      );
    if (settings.maxOutputTokens && settings.maxOutputTokens > profile.maxOutputTokens)
      throw new LlmConfigurationError(
        'STALE_OVERRIDE',
        'Output setting exceeds current profile bound; reset advanced settings',
      );
    if (
      (settings.reasoningEffort && !profile.reasoningEfforts?.includes(settings.reasoningEffort)) ||
      (settings.reasoningBudgetTokens &&
        settings.reasoningBudgetTokens > (profile.maxReasoningTokens ?? 0))
    )
      throw new LlmConfigurationError(
        'STALE_OVERRIDE',
        'Reasoning settings exceed current profile bounds; reset advanced settings',
      );
    if (profile.mode === 'automatic' && !this.operations)
      throw new LlmConfigurationError('UNAVAILABLE', 'Shared provider health unavailable');
    const backups = settings.backups ?? profile.backups;
    const selected = [settings.pinnedDeploymentId ?? profile.primary, ...backups];
    if (
      selected.some((id) => !profile.allowedDeployments.includes(id)) ||
      new Set(backups).size !== backups.length ||
      (settings.backups && backups.some((id) => !profile.backups.includes(id)))
    )
      throw new LlmConfigurationError(
        'STALE_OVERRIDE',
        'Deployment settings outside current profile permissions; reset settings',
      );
    // Partial responses stay on the original deployment, including for Members.
    const sticky = attempted.find((item) => item.output)?.deploymentId;
    const candidates = sticky
      ? [sticky]
      : settings.pinnedDeploymentId || profile.mode === 'manual'
        ? selected.slice(0, 1)
        : selected.filter((id) => !attempted.some((item) => item.deploymentId === id));
    // After all untried backups are exhausted, the existing scheduler may retry
    // an elapsed transient route within the same persisted recovery allowance.
    if (
      !sticky &&
      !candidates.length &&
      !settings.pinnedDeploymentId &&
      profile.mode === 'automatic'
    )
      candidates.push(...selected);
    const waits: string[] = [];
    let addressFailure: unknown;
    for (const candidate of candidates) {
      const deployment = config.deployments.find((row) => row.id === candidate && row.enabled);
      const connection =
        deployment &&
        config.connections.find((row) => row.id === deployment.connectionId && row.enabled);
      if (!deployment || !connection || !profile.allowedDeployments.includes(candidate)) continue;
      if (
        attempted.some(
          (item) =>
            item.connectionId === connection.id &&
            (item.permanent || (item.retryAt && Date.parse(item.retryAt) > this.now())),
        )
      )
        continue;
      const caps = deployment.capabilities;
      if ((settings.reasoningEffort || settings.reasoningBudgetTokens) && !caps.reasoning) continue;
      if (
        (settings.reasoningEffort && connection.adapter !== 'openai') ||
        (settings.reasoningBudgetTokens && connection.adapter !== 'anthropic')
      )
        continue;
      if (request.tools.length && !caps.tools) continue;
      if (request.messages.some((m) => m.blocks?.some((b) => b.kind === 'image')) && !caps.images)
        continue;
      if (request.messages.some((m) => m.blocks?.some((b) => b.kind === 'file')) && !caps.files)
        continue;
      if (request.messages.some((m) => m.reasoning?.length)) {
        // Signed active history is connection-bound. First route is only safe
        // when a receipt proves its origin; cross-connection use is refused.
        if (historyDeploymentId !== candidate) continue;
      }
      const maxOutputTokens = Math.min(
        request.maxOutputTokens ?? deployment.outputTokens,
        deployment.outputTokens,
        settings.maxOutputTokens ?? profile.maxOutputTokens,
      );
      if (settings.reasoningBudgetTokens && settings.reasoningBudgetTokens >= maxOutputTokens)
        continue;
      if (
        Math.ceil(estimateRequestTokens({ ...request, estimatedInputTokens: undefined }) * 1.15) +
          maxOutputTokens >
        deployment.contextTokens
      )
        continue;
      const key = state.credentials.find(
        (row) => row.connectionId === connection.id && !row.revoked,
      );
      if (!key) continue;
      if (
        profile.mode === 'automatic' &&
        !settings.pinnedDeploymentId &&
        this.operations &&
        (await this.operations.blocked(identity.tenantId, deployment.id, key.versionId))
      )
        continue;
      const cooldown = await this.operations?.cooldown(
        identity.tenantId,
        connection.id,
        deployment.id,
      );
      if (cooldown) {
        waits.push(cooldown);
        continue;
      }
      try {
        await this.policy.validate(connection.endpoint, request.signal);
      } catch (error) {
        if (
          profile.mode === 'automatic' &&
          !settings.pinnedDeploymentId &&
          !sticky &&
          (error as { code?: string }).code === 'UNAVAILABLE'
        ) {
          addressFailure = error;
          continue;
        }
        throw error;
      }
      const sealed = await this.configs.credential(identity.tenantId, connection.id, key.versionId);
      if (!sealed) continue;
      return {
        receipt: {
          ...(settings.profileId
            ? { profileName: config.profiles.find((row) => row.id === settings.profileId)?.name }
            : {}),
          deploymentName: deployment.name,
          revision: state.activeRevision,
          ...(settings.profileId
            ? { profileId: settings.profileId }
            : { selection: settings.model ? ('model' as const) : ('default' as const) }),
          automaticFallback: profile.mode === 'automatic',
          connectionId: connection.id,
          deploymentId: deployment.id,
          credentialVersionId: key.versionId,
          modelId: deployment.modelId,
          pricingKey: deployment.pricingKey,
          maxOutputTokens,
          ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
          ...(settings.reasoningBudgetTokens
            ? { reasoningBudgetTokens: settings.reasoningBudgetTokens }
            : {}),
          reason:
            settings.pinnedDeploymentId || settings.pinned
              ? 'pin'
              : candidate === profile.primary
                ? 'primary'
                : 'fallback',
        },
        connection,
        deployment: {
          ...deployment,
          settings: {
            ...deployment.settings,
            ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
            ...(settings.reasoningBudgetTokens
              ? {
                  thinkingType: 'enabled' as const,
                  reasoningBudgetTokens: settings.reasoningBudgetTokens,
                }
              : {}),
          },
        },
        requiresExpert: hasLlmSessionOverrides(settings),
        credential: await this.credentials.open(
          identity.tenantId,
          connection.id,
          key.versionId,
          sealed,
        ),
      };
    }
    if (waits.length) {
      const until = Math.min(...waits.map((value) => Date.parse(value)));
      throw Object.assign(new LlmConfigurationError('UNAVAILABLE', 'Provider cooldown is active'), {
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { 'retry-after-ms': String(Math.max(1, until - this.now())) },
      });
    }
    if (addressFailure) throw addressFailure;
    throw new LlmConfigurationError(
      'UNAVAILABLE',
      'No compatible approved deployment is available; contact an Admin or reset session settings',
    );
  }
  async observe(
    identity: Identity,
    requestId: string,
    route: LlmResolvedRoute,
    outcome: 'success' | 'transient' | 'permanent',
    cooldown?: LlmCooldown,
  ): Promise<void> {
    await this.operations?.observe(
      identity.tenantId,
      requestId,
      route.receipt.deploymentId,
      route.receipt.credentialVersionId,
      outcome,
      cooldown,
      route.receipt.connectionId,
    );
  }
  async admit(identity: Identity, route: LlmResolvedRoute): Promise<void> {
    const current = await this.current(identity);
    if (route.requiresExpert && !hasCapability(current.role, 'llm.session.tune'))
      throw new LlmConfigurationError(
        'STALE_OVERRIDE',
        'Reset advanced settings after account role change',
      );
    const state = await this.configs.read(identity.tenantId);
    const wait = await this.operations?.cooldown(
      identity.tenantId,
      route.connection.id,
      route.deployment.id,
    );
    if (wait)
      throw Object.assign(new LlmConfigurationError('UNAVAILABLE', 'Provider cooldown is active'), {
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { 'retry-after-ms': String(Math.max(1, Date.parse(wait) - this.now())) },
      });
    if (
      (route.receipt.automaticFallback ??
        state.published?.profiles.find((profile) => profile.id === route.receipt.profileId)
          ?.mode === 'automatic') &&
      route.receipt.reason !== 'pin' &&
      this.operations &&
      (await this.operations.blocked(
        identity.tenantId,
        route.deployment.id,
        route.receipt.credentialVersionId,
      ))
    )
      throw new LlmConfigurationError('UNAVAILABLE', 'Provider circuit opened before dispatch');
    if (
      state.activeRevision !== route.receipt.revision ||
      !state.credentials.some(
        (row) =>
          row.connectionId === route.connection.id &&
          row.versionId === route.receipt.credentialVersionId &&
          !row.revoked,
      )
    )
      throw new LlmConfigurationError(
        'UNAVAILABLE',
        'Routing changed before dispatch; retry the request',
      );
  }
}
