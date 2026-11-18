import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CoreToolRegistry, writeFileTool } from '../src/index.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const baseCtx = { sessionId: 's1', workspaceRoot: '/ws' };

describe('CoreToolRegistry', () => {
  it('allows composite tools to inherit cancellation without an implicit deadline', async () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      registry.register({
        name: 'composite',
        description: 'Runs under the task deadline',
        parameters: z.object({}),
        timeoutMs: null,
        execute: async (_args, ctx) => {
          expect(ctx.signal).toBe(controller.signal);
          controller.abort(new Error('Task cancelled'));
          ctx.signal?.throwIfAborted();
          return { value: 'unexpected', isError: false };
        },
      });
      expect(
        await registry.execute(
          { id: 'c', name: 'composite', args: {} },
          { ...baseCtx, signal: controller.signal },
        ),
      ).toMatchObject({
        isError: true,
        value: { message: 'Task cancelled' },
      });
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });
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

  it('advertises defaulted tool arguments as optional inputs and applies defaults at dispatch', async () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register({
      name: 'bounded-read',
      description: 'Read with a default limit',
      parameters: z.object({ path: z.string(), limit: z.number().int().positive().default(10) }),
      execute: async (args) => ({ value: args, isError: false }),
    });
    expect(registry.schemas()[0]!.parameters.required).toEqual(['path']);
    expect(
      await registry.execute({ id: 'read', name: 'bounded-read', args: { path: 'x' } }, baseCtx),
    ).toMatchObject({ isError: false, value: { path: 'x', limit: 10 } });
  });

  it.each(['discriminated', 'ordinary'])(
    'advertises %s object unions with an explicit root type and preserves branch validation',
    async (kind) => {
      const variants = [
        z.object({ operation: z.literal('read'), limit: z.number().positive().default(10) }),
        z.object({ operation: z.literal('write'), content: z.string() }),
      ] as const;
      const schema =
        kind === 'discriminated' ? z.discriminatedUnion('operation', variants) : z.union(variants);
      const registry = new CoreToolRegistry(new FakeSandbox());
      const execute = vi.fn(async (args: unknown) => ({ value: args, isError: false }));
      registry.register({
        name: 'union',
        description: 'Object union',
        parameters: schema,
        execute,
      });
      const parameters = registry.schemas()[0]!.parameters;
      expect(parameters.type).toBe('object');
      const key = kind === 'discriminated' ? 'oneOf' : 'anyOf';
      const branches = parameters[key] as {
        required: string[];
        properties: Record<string, unknown>;
      }[];
      expect(branches).toHaveLength(2);
      expect(branches[0]!.required).toEqual(['operation']);
      expect(branches[1]!.required).toEqual(['operation', 'content']);
      expect(branches[0]!.properties.limit).toMatchObject({ default: 10 });
      expect(
        await registry.execute({ id: 'read', name: 'union', args: { operation: 'read' } }, baseCtx),
      ).toMatchObject({ isError: false, value: { operation: 'read', limit: 10 } });
      expect(
        await registry.execute({ id: 'bad', name: 'union', args: { operation: 'write' } }, baseCtx),
      ).toMatchObject({ isError: true });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
  it('does not narrow a mixed union to object inputs', () => {
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register({
      name: 'mixed',
      description: 'Mixed',
      parameters: z.union([z.object({}), z.string()]),
      execute: async (args) => ({ value: args, isError: false }),
    });
    expect(registry.schemas()[0]!.parameters.type).toBeUndefined();
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
