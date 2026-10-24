import { expect, it } from 'vitest';
import { nodeAgentEnvSchema } from '../src/env.js';

const baseEnvironment = {
  DATABASE_URL: 'postgres://trinity@localhost/trinity',
  NODE_RUNTIME_TOKEN: 'x'.repeat(32),
  NODE_ID: 'host-1',
  NODE_STATE_DIR: '/srv/trinity-node',
  NODE_PORT: '3030',
};

it('allows explicitly unencrypted storage only for development hosts', () => {
  expect(
    nodeAgentEnvSchema.safeParse({
      ...baseEnvironment,
      NODE_DEPLOYMENT_MODE: 'development',
      NODE_STORAGE_ENCRYPTION: 'none',
    }).success,
  ).toBe(true);

  expect(
    nodeAgentEnvSchema.safeParse({
      ...baseEnvironment,
      NODE_DEPLOYMENT_MODE: 'production',
      NODE_STORAGE_ENCRYPTION: 'none',
    }).success,
  ).toBe(false);
});

it('accepts host-managed and provider-managed encryption in production', () => {
  for (const encryption of ['host-managed', 'provider-managed']) {
    expect(
      nodeAgentEnvSchema.safeParse({
        ...baseEnvironment,
        NODE_DEPLOYMENT_MODE: 'production',
        NODE_STORAGE_ENCRYPTION: encryption,
      }).success,
    ).toBe(true);
  }
});
