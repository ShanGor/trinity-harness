import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CoreToolRegistry, writeFileTool } from '../src/index.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const baseCtx = { sessionId: 's1', workspaceRoot: '/ws' };

describe('CoreToolRegistry', () => {
  it('injects the sandbox and executes a registered tool', async () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(writeFileTool);
    const result = await registry.execute(
      { id: 'c1', name: 'write_file', args: { path: 'x.txt', content: 'hello' } },
      baseCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.value).toEqual({ path: 'x.txt', bytes: 5 });
  });

  it('returns isError for unknown tools instead of throwing', async () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    const result = await registry.execute({ id: 'c1', name: 'nope', args: {} }, baseCtx);
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({ message: 'unknown tool: nope' });
  });

  it('validates arguments with zod before executing', async () => {
    const sandbox = new FakeSandbox();
    const registry = new CoreToolRegistry(sandbox);
    registry.register(writeFileTool);
    const result = await registry.execute(
      { id: 'c1', name: 'write_file', args: { path: 42 } },
      baseCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({ message: 'invalid arguments for write_file' });
    expect(sandbox.files.size).toBe(0); // never executed
  });

  it('converts tool exceptions into isError results', async () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(writeFileTool);
    const result = await registry.execute(
      { id: 'c1', name: 'write_file', args: { path: 'x.txt', content: 'hi' } },
      baseCtx,
    );
    // FakeSandbox writeFile cannot fail; assert convergence via a throwing tool below.
    expect(result.isError).toBe(false);

    const throwing = {
      name: 'boom',
      description: 'always throws',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('kaboom');
      },
    };
    registry.register(throwing);
    const failed = await registry.execute({ id: 'c2', name: 'boom', args: {} }, baseCtx);
    expect(failed.isError).toBe(true);
    expect(failed.value).toEqual({ message: 'kaboom' });
  });

  it('exposes JSON schemas for the LLM', () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(writeFileTool);
    const [schema] = registry.schemas();
    expect(schema!.name).toBe('write_file');
    expect(schema!.description).toBe(writeFileTool.description);
    expect(schema!.parameters).toMatchObject({ type: 'object' });
    expect(Object.keys(schema!.parameters)).toContain('properties');
  });

  it('dispose unregisters the tool', async () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    const handle = registry.register(writeFileTool);
    handle.dispose();
    const result = await registry.execute(
      { id: 'c1', name: 'write_file', args: { path: 'x', content: 'y' } },
      baseCtx,
    );
    expect(result.isError).toBe(true);
  });
});
