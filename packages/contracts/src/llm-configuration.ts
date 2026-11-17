import { tokenUsageSchema, modelPriceSchema, usageCostSchema } from './usage.js';
import type { LlmRouteReceipt } from './llm-route.js';
export { llmRouteReceiptSchema } from './llm-route.js';
export type { LlmRouteReceipt } from './llm-route.js';
import { z } from 'zod';
import type { Identity } from './identity.js';
import type { LLMRequest } from './llm.js';

const id = z.uuid();
const name = z.string().trim().min(1).max(100);
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export const llmConnectionSchema = z
  .object({
    id,
    name,
    adapter: z.enum(['anthropic', 'openai']),
    endpoint: z.string().url().max(2048),
    enabled: z.boolean(),
  })
  .strict();
export const llmDeploymentSchema = z
  .object({
    id,
    name,
    connectionId: id,
    modelId: z.string().min(1).max(256),
    pricingKey: z.string().min(1).max(200),
    enabled: z.boolean(),
    contextTokens: z.number().int().min(1024).max(10_000_000),
    outputTokens: z.number().int().min(1).max(1_000_000),
    capabilities: z
      .object({
        tools: z.boolean(),
        images: z.boolean(),
        files: z.boolean(),
        reasoning: z.boolean(),
      })
      .strict(),
    settings: z
      .object({
        thinkingType: z.enum(['adaptive', 'enabled', 'disabled']).optional(),
        reasoningBudgetTokens: z.number().int().min(1).max(1_000_000).optional(),
        reasoningEffort: effort.optional(),
      })
      .strict(),
  })
  .strict();
export const llmProfileSchema = z
  .object({
    id,
    name,
    primary: id,
    backups: z.array(id).max(3),
    mode: z.enum(['manual', 'automatic']),
    allowedDeployments: z.array(id).max(256),
    maxOutputTokens: z.number().int().positive().max(1_000_000),
    reasoningEfforts: z.array(effort).max(6).optional(),
    maxReasoningTokens: z.number().int().min(1024).max(1_000_000).optional(),
  })
  .strict();
export const llmModelReferenceSchema = z
  .object({ providerId: id, modelId: z.string().min(1).max(256) })
  .strict();
export type LlmModelReference = z.infer<typeof llmModelReferenceSchema>;
export const llmDirectRoutingSchema = z
  .object({
    defaultModel: llmModelReferenceSchema.nullable(),
    automaticFallback: z.boolean(),
    fallbackModels: z.array(llmModelReferenceSchema).max(3),
  })
  .strict();
export const llmConfigurationSchema = z
  .object({
    connections: z.array(llmConnectionSchema).max(64),
    deployments: z.array(llmDeploymentSchema).max(256),
    profiles: z.array(llmProfileSchema).max(64),
    // Empty is valid in a saved draft while the first profile is being configured.
    defaultProfileId: z.union([id, z.literal('')]),
    routing: llmDirectRoutingSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    for (const rows of [config.connections, config.deployments, config.profiles])
      if (new Set(rows.map((row) => row.id)).size !== rows.length) issue('Duplicate identifiers');
    const connections = new Map(config.connections.map((row) => [row.id, row]));
    const deployments = new Map(config.deployments.map((row) => [row.id, row]));
    for (const deployment of config.deployments) {
      const connection = connections.get(deployment.connectionId);
      if (!connection) issue('Deployment references missing connection');
      if (deployment.outputTokens > deployment.contextTokens) issue('Output exceeds context');
      if (
        connection?.adapter === 'openai' &&
        (deployment.settings.thinkingType || deployment.settings.reasoningBudgetTokens)
      )
        issue('Anthropic settings on OpenAI connection');
      if (connection?.adapter === 'anthropic' && deployment.settings.reasoningEffort)
        issue('OpenAI settings on Anthropic connection');
    }
    for (const profile of config.profiles) {
      const targets = [profile.primary, ...profile.backups];
      if (new Set(targets).size !== targets.length) issue('Duplicate routing targets');
      if (new Set(profile.allowedDeployments).size !== profile.allowedDeployments.length)
        issue('Duplicate approved deployments');
      for (const target of profile.allowedDeployments)
        if (!deployments.has(target)) issue('Missing approved deployment');
      for (const target of targets) {
        const deployment = deployments.get(target);
        if (
          !deployment ||
          !deployment.enabled ||
          !connections.get(deployment.connectionId)?.enabled
        )
          issue('Route must reference an enabled deployment and connection');
        if (!profile.allowedDeployments.includes(target))
          issue('Route outside approved destinations');
      }
    }
    if (
      config.profiles.length > 0 &&
      !config.profiles.some((profile) => profile.id === config.defaultProfileId)
    )
      issue('Missing default profile');
    if (config.routing) {
      if (config.profiles.length || config.defaultProfileId)
        issue('Direct routing cannot contain profiles');
      const refs = [config.routing.defaultModel, ...config.routing.fallbackModels].filter(
        (ref) => !!ref,
      );
      if (new Set(refs.map((ref) => `${ref.providerId}/${ref.modelId}`)).size !== refs.length)
        issue('Duplicate routing models');
      for (const ref of refs) {
        const model = config.deployments.find(
          (row) => row.connectionId === ref.providerId && row.modelId === ref.modelId,
        );
        if (!model?.enabled || !connections.get(ref.providerId)?.enabled)
          issue('Routing model must be enabled');
      }
      if (
        new Set(config.deployments.map((row) => `${row.connectionId}/${row.modelId}`)).size !==
        config.deployments.length
      )
        issue('Duplicate provider model');
    }
    if (JSON.stringify(config).length > 512_000) issue('Configuration too large');
  });
/** A draft can be assembled incrementally; only publication requires a usable route. */
export const llmPublishedConfigurationSchema = llmConfigurationSchema.superRefine((config, ctx) => {
  if (config.connections.length === 0)
    ctx.addIssue({ code: 'custom', message: 'Add at least one provider connection' });
  if (config.deployments.length === 0)
    ctx.addIssue({ code: 'custom', message: 'Add at least one model deployment' });
  if (!config.routing && config.profiles.length === 0)
    ctx.addIssue({ code: 'custom', message: 'Add at least one routing profile' });
  if (!config.routing && !config.profiles.some((profile) => profile.id === config.defaultProfileId))
    ctx.addIssue({ code: 'custom', message: 'Choose a valid default profile' });
  for (const profile of config.profiles)
    if (profile.allowedDeployments.length === 0)
      ctx.addIssue({
        code: 'custom',
        message: `Profile ${profile.name} must approve a deployment`,
      });
});
export type LlmConfiguration = z.infer<typeof llmConfigurationSchema>;
export type LlmConnection = z.infer<typeof llmConnectionSchema>;
export type LlmDeployment = z.infer<typeof llmDeploymentSchema>;
export type LlmProfile = z.infer<typeof llmProfileSchema>;
export const llmConfigurationStateSchema = z.object({
  version: z.number().int().nonnegative(),
  activeRevision: z.number().int().positive().nullable(),
  source: z.enum(['environment', 'database']),
  draft: llmConfigurationSchema.nullable(),
  published: llmConfigurationSchema.nullable(),
  credentials: z.array(z.object({ connectionId: id, versionId: id, revoked: z.boolean() })),
});
export type LlmConfigurationState = z.infer<typeof llmConfigurationStateSchema>;
export const llmConfigurationSaveSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    operationId: id,
    configuration: llmConfigurationSchema,
  })
  .strict();
export const llmConfigurationPublishSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    operationId: id,
    reason: z.string().trim().min(1).max(500),
    restoreRevision: z.number().int().positive().optional(),
  })
  .strict();
export const llmCredentialWriteSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    operationId: id,
    secret: z
      .string()
      .min(1)
      .max(16_384)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 16_384,
        'Secret exceeds byte limit',
      ),
  })
  .strict();
export const llmSessionSettingsSchema = z
  .object({
    profileId: id.optional(),
    model: llmModelReferenceSchema.optional(),
    followDefault: z.literal(true).optional(),
    pinned: z.boolean().optional(),
    pinnedDeploymentId: id.optional(),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
    reasoningEffort: effort.optional(),
    reasoningBudgetTokens: z.number().int().min(1024).max(1_000_000).optional(),
    backups: z.array(id).max(3).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [!!value.profileId, !!value.model, !!value.followDefault].filter(Boolean).length === 1,
    'Choose default or one model',
  );
export type LlmSessionSettings = z.infer<typeof llmSessionSettingsSchema>;
export function hasLlmSessionOverrides(settings: LlmSessionSettings): boolean {
  return !!(
    settings.pinned ||
    settings.pinnedDeploymentId ||
    settings.maxOutputTokens ||
    settings.backups ||
    settings.reasoningEffort ||
    settings.reasoningBudgetTokens
  );
}
export const llmActivitySchema = z.object({
  id,
  at: z.iso.datetime(),
  actor: z.string(),
  action: z.enum([
    'draft',
    'publish',
    'rollback',
    'credential.replace',
    'credential.revoke',
    'configure',
  ]),
  version: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});
export type LlmActivity = z.infer<typeof llmActivitySchema>;
export interface LlmConfigurationPort {
  configure?(
    identity: Identity,
    input: {
      expectedVersion: number;
      operationId: string;
      configuration: LlmConfiguration;
      sealedKeys: { connectionId: string; sealed: string }[];
    },
  ): Promise<LlmConfigurationState>;
  read(tenantId: string): Promise<LlmConfigurationState>;
  impact(tenantId: string, expectedVersion: number): Promise<LlmConfigurationImpact>;
  revision(tenantId: string, revision: number): Promise<LlmConfiguration | null>;
  save(
    identity: Identity,
    input: z.infer<typeof llmConfigurationSaveSchema>,
  ): Promise<LlmConfigurationState>;
  publish(
    identity: Identity,
    input: z.infer<typeof llmConfigurationPublishSchema>,
  ): Promise<LlmConfigurationState>;
  replaceCredential(
    identity: Identity,
    connectionId: string,
    input: Omit<z.infer<typeof llmCredentialWriteSchema>, 'secret'>,
    sealed: string,
  ): Promise<LlmConfigurationState>;
  revokeCredential(
    identity: Identity,
    connectionId: string,
    input: { expectedVersion: number; operationId: string },
  ): Promise<LlmConfigurationState>;
  credential(tenantId: string, connectionId: string, versionId: string): Promise<string | null>;
  activity(tenantId: string): Promise<LlmActivity[]>;
}
export interface LlmCredentialPort {
  seal(tenantId: string, connectionId: string, versionId: string, secret: string): Promise<string>;
  open(tenantId: string, connectionId: string, versionId: string, sealed: string): Promise<string>;
}
export interface LlmEndpointPolicyPort {
  validateConfiguration(endpoint: string): void;
  validate(endpoint: string, signal?: AbortSignal): Promise<void>;
  fetch: typeof globalThis.fetch;
}
export interface LlmResolvedRoute {
  receipt: LlmRouteReceipt;
  connection: LlmConnection;
  deployment: LlmDeployment;
  /** Secret is dispatched only inside the gateway; never attach it to a request artifact. */
  credential: string;
  requiresExpert?: boolean;
}
export interface LlmRouteAttempt {
  deploymentId: string;
  connectionId: string;
  output: boolean;
  retryAt?: string | undefined;
  permanent?: boolean | undefined;
}
export const llmRoutingLimitsSchema = z.object({
  model: z.string().max(200),
  contextTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
});
export type LlmRoutingLimits = z.infer<typeof llmRoutingLimitsSchema>;
export const llmCooldownSchema = z.object({
  until: z.iso.datetime(),
  scope: z.enum(['connection', 'deployment']),
});
export type LlmCooldown = z.infer<typeof llmCooldownSchema>;
export interface LlmRoutingPort {
  limits(sessionId: string, actor: string): Promise<LlmRoutingLimits | null>;
  session(
    sessionId: string,
    actor: string,
  ): Promise<{ identity: Identity; settings: LlmSessionSettings } | null>;
  resolve(
    identity: Identity,
    settings: LlmSessionSettings,
    request: LLMRequest,
    attempted: LlmRouteAttempt[],
    historyDeploymentId?: string,
  ): Promise<LlmResolvedRoute>;
  admit(identity: Identity, route: LlmResolvedRoute): Promise<void>;
  observe(
    identity: Identity,
    requestId: string,
    route: LlmResolvedRoute,
    outcome: 'success' | 'transient' | 'permanent',
    cooldown?: LlmCooldown,
  ): Promise<void>;
}
export class LlmConfigurationError extends Error {
  constructor(
    public readonly code:
      | 'FORBIDDEN'
      | 'CONFLICT'
      | 'UNAVAILABLE'
      | 'INVALID'
      | 'MIGRATION_REQUIRED'
      | 'STALE_OVERRIDE',
    message: string,
  ) {
    super(message);
    this.name = 'LlmConfigurationError';
  }
}
export const llmProfilesResponseSchema = z.object({
  available: z.boolean(),
  defaultProfileId: id.optional(),
  canTune: z.boolean().optional(),
  profiles: z
    .array(
      z.object({
        id,
        name,
        mode: z.enum(['manual', 'automatic']),
        maxOutputTokens: z.number().int().positive(),
        reasoningEfforts: z.array(effort).max(6).optional(),
        maxReasoningTokens: z.number().int().positive().optional(),
        backups: z.array(id).max(3).optional(),
        deployments: z.array(z.object({ id, name })).max(256).optional(),
      }),
    )
    .max(64),
});
export type LlmProfilesResponse = z.infer<typeof llmProfilesResponseSchema>;
export const llmSessionSettingsResponseSchema = z.object({
  expectedLastSeq: z.number().int().nonnegative(),
  settings: llmSessionSettingsSchema.nullable(),
});
export type LlmSessionSettingsResponse = z.infer<typeof llmSessionSettingsResponseSchema>;
export const llmProbeResultSchema = z.object({
  operationId: id,
  connectionId: id,
  deploymentId: id,
  version: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  status: z.enum(['pending', 'passed', 'failed', 'unknown']),
  tokens: tokenUsageSchema.optional(),
  pricingKey: z.string().max(200).optional(),
  pricing: modelPriceSchema.optional(),
  cost: usageCostSchema.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
export type LlmProbeResult = z.infer<typeof llmProbeResultSchema>;
export interface LlmProviderOperationsPort {
  beginProbe(
    identity: Identity,
    operationId: string,
    connectionId: string,
    deploymentId: string,
    expectedVersion: number,
  ): Promise<{ admitted: boolean; result: LlmProbeResult }>;
  finishProbe(tenantId: string, result: LlmProbeResult): Promise<void>;
  probes(tenantId: string): Promise<LlmProbeResult[]>;
  health(tenantId: string): Promise<LlmHealthSnapshot[]>;
  cooldown(tenantId: string, connectionId: string, deploymentId: string): Promise<string | null>;
  blocked(tenantId: string, deploymentId: string, credentialVersionId: string): Promise<boolean>;
  observe(
    tenantId: string,
    requestId: string,
    deploymentId: string,
    credentialVersionId: string,
    outcome: 'success' | 'transient' | 'permanent',
    cooldown?: LlmCooldown,
    connectionId?: string,
  ): Promise<void>;
  restore(tenantId: string, deploymentId: string, credentialVersionId: string): Promise<void>;
}

/** Internal encryption envelope; never part of administrative read DTOs. */
export const llmSealedCredentialSchema = z
  .object({
    version: z.literal(1),
    wrappedKey: z.string().max(64),
    wrapIv: z.string().max(32),
    wrapTag: z.string().max(32),
    keyId: z.string().min(1).max(100),
    iv: z.string().max(32),
    tag: z.string().max(32),
    body: z.string().max(32768),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const llmConfigurationImpactSchema = z.object({
  version: z.number().int().nonnegative(),
  unboundSessions: z.number().int().nonnegative(),
  bindings: z
    .array(
      z.object({
        profileId: id,
        sessions: z.number().int().nonnegative(),
        pins: z.number().int().nonnegative(),
      }),
    )
    .max(128),
});
export type LlmConfigurationImpact = z.infer<typeof llmConfigurationImpactSchema>;
export const llmHealthSnapshotSchema = z.object({
  deploymentId: id,
  credentialVersionId: id,
  state: z.enum(['open', 'closed']),
  observedAt: z.iso.datetime(),
  failures: z.number().int().nonnegative(),
  credentialBlocked: z.boolean(),
  retryAt: z.iso.datetime().optional(),
});
export type LlmHealthSnapshot = z.infer<typeof llmHealthSnapshotSchema>;
export const llmActivityListSchema = z.object({ activity: z.array(llmActivitySchema).max(100) });
export const llmProbeListSchema = z.object({ tests: z.array(llmProbeResultSchema).max(100) });
export const llmHealthListSchema = z.object({ health: z.array(llmHealthSnapshotSchema).max(100) });
export const llmSessionSettingsWriteSchema = z
  .object({
    settings: llmSessionSettingsSchema,
    operationId: id,
    expectedLastSeq: z.number().int().nonnegative(),
  })
  .strict();
export const llmProbeRequestSchema = z
  .object({ operationId: id, expectedVersion: z.number().int().nonnegative(), deploymentId: id })
  .strict();

export const llmProviderSettingsSchema = z
  .object({
    providers: z.array(llmConnectionSchema).max(64),
    models: z.array(llmDeploymentSchema).max(256),
    routing: llmDirectRoutingSchema,
  })
  .strict();
export type LlmProviderSettings = z.infer<typeof llmProviderSettingsSchema>;
export const llmProviderSettingsWriteSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    operationId: id,
    settings: llmProviderSettingsSchema,
    keys: z
      .array(z.object({ providerId: id, secret: llmCredentialWriteSchema.shape.secret }).strict())
      .max(64),
  })
  .strict();
export const llmProviderSettingsResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  settings: llmProviderSettingsSchema,
  credentials: z.array(z.object({ providerId: id, configured: z.boolean() })).max(64),
  migrationRequired: z.boolean(),
});
export type LlmProviderSettingsResponse = z.infer<typeof llmProviderSettingsResponseSchema>;

/** Internal dispatch policy, computed directly from selection; never stored as a profile. */
export function llmSelectionPolicy(
  config: LlmConfiguration,
  settings: LlmSessionSettings,
): Omit<LlmProfile, 'id' | 'name'> {
  if (settings.profileId) {
    const old = config.profiles.find((row) => row.id === settings.profileId);
    if (!old)
      throw new LlmConfigurationError('MIGRATION_REQUIRED', 'Select a model for this conversation');
    return old;
  }
  if (!config.routing)
    throw new LlmConfigurationError(
      'MIGRATION_REQUIRED',
      'Select a model after provider migration',
    );
  const ref = settings.model ?? config.routing.defaultModel;
  const primary = config.deployments.find(
    (row) => row.connectionId === ref?.providerId && row.modelId === ref?.modelId,
  );
  if (!primary) throw new LlmConfigurationError('UNAVAILABLE', 'Select an available default model');
  const backups = config.routing.fallbackModels
    .map(
      (ref) =>
        config.deployments.find(
          (row) => row.connectionId === ref.providerId && row.modelId === ref.modelId,
        )?.id,
    )
    .filter((value): value is string => !!value && value !== primary.id);
  return {
    primary: primary.id,
    backups,
    mode: config.routing.automaticFallback && !settings.pinned ? 'automatic' : 'manual',
    allowedDeployments: config.deployments
      .filter(
        (row) =>
          row.enabled &&
          config.connections.some(
            (provider) => provider.id === row.connectionId && provider.enabled,
          ),
      )
      .map((row) => row.id),
    maxOutputTokens: primary.outputTokens,
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    maxReasoningTokens: Math.max(1024, primary.outputTokens - 1),
  };
}
export const llmModelsResponseSchema = z.object({
  available: z.boolean(),
  canTune: z.boolean(),
  defaultModel: llmModelReferenceSchema.nullable(),
  models: z
    .array(
      llmDeploymentSchema.extend({
        providerName: name,
        adapter: z.enum(['openai', 'anthropic']).optional(),
      }),
    )
    .max(256),
});
export type LlmModelsResponse = z.infer<typeof llmModelsResponseSchema>;
