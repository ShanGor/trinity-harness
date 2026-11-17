/** Operator-only composition root. Imports environment credentials into one explicitly named tenant draft. */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { llmConfigurationSchema, roleSchema } from '@trinity-harness/contracts';
import { createDb, createPool, PgLlmConfigurationStore, PgUserStore } from '@trinity-harness/db';
import {
  ScryptPasswordHasher,
  infrastructureCredentials,
  ProviderEndpointPolicy,
  llmInfrastructureEnvShape,
} from '@trinity-harness/core';

for (const relative of ['../../../.env', '../.env'])
  loadDotenv({ path: fileURLToPath(new URL(relative, import.meta.url)), quiet: true });

const { values } = parseArgs({
  options: {
    'tenant-id': { type: 'string' },
    'admin-id': { type: 'string' },
    'allow-tools': { type: 'boolean' },
    'allow-images': { type: 'boolean' },
    'allow-files': { type: 'boolean' },
    'allow-reasoning': { type: 'boolean' },
  },
  strict: true,
});
if (!values['tenant-id'] || !values['admin-id'])
  throw new Error(
    'Explicit --tenant-id and --admin-id are required. This command saves a reviewed draft only; it does not activate routing.',
  );
const databaseUrl = process.env['DATABASE_URL'];
const model = process.env['MODEL'];
if (!databaseUrl || !model) throw new Error('DATABASE_URL and MODEL are required');
const slash = model.indexOf('/');
const adapter = model.slice(0, slash);
if (slash < 1 || !['openai', 'anthropic'].includes(adapter))
  throw new Error('Only declared OpenAI/Anthropic SDK adapters can be imported');
const prefix = adapter === 'anthropic' ? 'ANTHROPIC' : 'OPENAI';
const secret = process.env[`${prefix}_API_KEY`];
if (!secret) throw new Error('Selected adapter credential is not configured');
const infrastructure = infrastructureCredentials(
  process.env['LLM_CREDENTIAL_KEY_ID'],
  process.env['LLM_CREDENTIAL_KEYS'],
);
const destinations = llmInfrastructureEnvShape.LLM_PROVIDER_DESTINATIONS.parse(
  process.env['LLM_PROVIDER_DESTINATIONS'],
);
const policy = new ProviderEndpointPolicy(destinations);
const endpoint =
  process.env[`${prefix}_BASE_URL`] ??
  (adapter === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
policy.validateConfiguration(endpoint);
const pool = createPool(databaseUrl);
try {
  const db = createDb(pool);
  const users = new PgUserStore(db, new ScryptPasswordHasher());
  const admin = await users.findById(values['admin-id']);
  if (!admin || admin.tenantId !== values['tenant-id'] || roleSchema.parse(admin.role) !== 'admin')
    throw new Error('The specified Admin does not belong to the specified tenant');
  const configs = new PgLlmConfigurationStore(db);
  const existing = await configs.read(admin.tenantId);
  if (existing.version !== 0 || existing.source !== 'environment')
    throw new Error(
      'Import requires an untouched legacy tenant; configure existing drafts through Administration',
    );
  const connectionId = randomUUID(),
    deploymentId = randomUUID(),
    profileId = randomUUID();
  const configuration = llmConfigurationSchema.parse({
    connections: [
      { id: connectionId, name: 'Imported connection', adapter, endpoint, enabled: true },
    ],
    deployments: [
      {
        id: deploymentId,
        name: 'Imported model',
        connectionId,
        modelId: model.slice(slash + 1),
        pricingKey: model,
        enabled: true,
        contextTokens: Number(process.env['MODEL_CONTEXT_TOKENS'] ?? 200000),
        outputTokens: Number(process.env['MODEL_OUTPUT_TOKENS'] ?? 8192),
        capabilities: {
          tools: !!values['allow-tools'],
          images: !!values['allow-images'],
          files: !!values['allow-files'],
          reasoning: !!values['allow-reasoning'],
        },
        settings: {
          ...(process.env['REASONING_EFFORT']
            ? { reasoningEffort: process.env['REASONING_EFFORT'] }
            : {}),
          ...(process.env['REASONING_BUDGET_TOKENS']
            ? {
                thinkingType: 'enabled',
                reasoningBudgetTokens: Number(process.env['REASONING_BUDGET_TOKENS']),
              }
            : {}),
        },
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
        maxOutputTokens: Number(process.env['MODEL_OUTPUT_TOKENS'] ?? 8192),
      },
    ],
    defaultProfileId: profileId,
  });
  const identity = { tenantId: admin.tenantId, userId: admin.id, role: admin.role };
  const draft = await configs.save(identity, {
    expectedVersion: 0,
    operationId: randomUUID(),
    configuration,
  });
  const operationId = randomUUID();
  await configs.replaceCredential(
    identity,
    connectionId,
    { expectedVersion: draft.version, operationId },
    await infrastructure.seal(admin.tenantId, connectionId, operationId, secret),
  );
  console.log(
    'Imported a tenant-bound draft and encrypted credential. Review destinations, capabilities, pricing and existing conversation bindings in Administration before publishing. Routing remains in environment mode.',
  );
} finally {
  await pool.end();
}
