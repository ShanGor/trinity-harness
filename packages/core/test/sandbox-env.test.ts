import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalSandbox } from '@trinity-harness/core';

/**
 * M5 sandbox hardening (docs/design.md §12.3): the DEFAULT env mode must not
 * propagate server secrets into spawned shells/processes (AGENTS.md §5).
 */

describe('LocalSandbox env scrubbing (M5)', () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'trinity-sandbox-'));
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('minimal mode (default): secrets never reach tool children', async () => {
    process.env['TRINITY_TEST_SECRET'] = 'super-secret-value';
    try {
      const sandbox = new LocalSandbox(workspace);
      const result = await sandbox.exec('env');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('TRINITY_TEST_SECRET');
      expect(result.stdout).not.toContain('super-secret-value');
      // Operational variables survive so tools/language servers keep working.
      expect(result.stdout).toContain('PATH=');
      expect(result.stdout).toContain(`TRINITY_WORKSPACE=${workspace}`);
    } finally {
      delete process.env['TRINITY_TEST_SECRET'];
    }
  });

  it('explicit opts.env values still pass through in minimal mode', async () => {
    const sandbox = new LocalSandbox(workspace);
    const result = await sandbox.exec('printf "%s" "$MARKER"', { env: { MARKER: 'hello' } });
    expect(result.stdout).toBe('hello');
  });

  it('preserves the runtime socket directory without passing browser credentials or other configuration', async () => {
    const keys = ['XDG_RUNTIME_DIR', 'AGENT_BROWSER_ENCRYPTION_KEY', 'AGENT_BROWSER_SESSION'];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env['XDG_RUNTIME_DIR'] = '/tmp/trinity-test-runtime';
    process.env['AGENT_BROWSER_ENCRYPTION_KEY'] = 'secret';
    process.env['AGENT_BROWSER_SESSION'] = 'default';
    try {
      const result = await new LocalSandbox(workspace).exec('env');
      expect(result.stdout).toContain('XDG_RUNTIME_DIR=/tmp/trinity-test-runtime');
      expect(result.stdout).not.toContain('AGENT_BROWSER_ENCRYPTION_KEY');
      expect(result.stdout).not.toContain('AGENT_BROWSER_SESSION');
    } finally {
      for (const key of keys) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  });

  it('inherit mode keeps the legacy full-passthrough behavior', async () => {
    process.env['TRINITY_TEST_SECRET'] = 'super-secret-value';
    try {
      const sandbox = new LocalSandbox(workspace, { envMode: 'inherit' });
      const result = await sandbox.exec('printf "%s" "$TRINITY_TEST_SECRET"');
      expect(result.stdout).toBe('super-secret-value');
    } finally {
      delete process.env['TRINITY_TEST_SECRET'];
    }
  });
});
