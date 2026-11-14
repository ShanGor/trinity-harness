import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LocalSandbox } from '../src/sandbox/local-sandbox.js';
import { workspaceCopyPaths, workspaceCopyScript } from '../src/tools/workspace-copy.js';

it('recognizes only simple nonsensitive contained copy paths', () => {
  expect(workspaceCopyPaths('cp source.txt dest.txt')).toEqual(['source.txt', 'dest.txt']);
  for (const command of [
    'cp .env dest',
    'cp ../outside dest',
    'cp a /tmp/b',
    'cp -r a b',
    'cp a b && ls',
    'cp a b c',
  ])
    expect(workspaceCopyPaths(command)).toBeUndefined();
});

it('creates exclusively, refuses raced destinations and symlinks without replacing content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-copy-'));
  const sandbox = new LocalSandbox(root);
  const run = (src: string, dest: string, mode = 'copy') =>
    sandbox.execArgv(process.execPath, ['-e', workspaceCopyScript, src, dest, mode], {
      maxOutputBytes: 1024,
    });
  try {
    await writeFile(path.join(root, 'source'), 'original');
    expect((await run('source', 'dest', 'probe')).stdout).toBe('new');
    await writeFile(path.join(root, 'dest'), 'raced');
    expect((await run('source', 'dest')).exitCode).not.toBe(0);
    expect(await readFile(path.join(root, 'dest'), 'utf8')).toBe('raced');
    expect((await run('source', 'fresh')).exitCode).toBe(0);
    expect(await readFile(path.join(root, 'fresh'), 'utf8')).toBe('original');
    await symlink(root, path.join(root, 'link'));
    expect((await run('link/source', 'another')).exitCode).not.toBe(0);
    expect((await run('source', 'link/another')).exitCode).not.toBe(0);
    expect((await run('source', 'link')).exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('allows new copies through stock policy while preserving explicit asks and denials', async () => {
  const { CoreToolRegistry } = await import('../src/tool-registry.js');
  const { PolicyToolRegistry } = await import('../src/policy-tool-registry.js');
  const { bashTool } = await import('../src/tools/builtin.js');
  const root = await mkdtemp(path.join(tmpdir(), 'copy-policy-'));
  try {
    await writeFile(path.join(root, 'source'), 'data');
    const inner = new CoreToolRegistry(new LocalSandbox(root));
    inner.register(bashTool);
    const call = { id: 'copy', name: 'bash', args: { command: 'cp source dest' } };
    const ctx = { sessionId: 's', workspaceRoot: root };
    expect(
      await new PolicyToolRegistry(inner, {
        tools: {},
        onAsk: 'ask',
        allowWorkspaceInternalBash: true,
      }).assess(call, ctx),
    ).toMatchObject({
      decision: 'allowed',
    });
    expect(
      await new PolicyToolRegistry(inner, {
        tools: { bash: 'ask' },
        onAsk: 'ask',
        allowWorkspaceInternalBash: true,
      }).assess(call, ctx),
    ).toMatchObject({ decision: 'ask' });
    expect(
      await new PolicyToolRegistry(inner, {
        tools: { bash: 'denied' },
        onAsk: 'ask',
        allowWorkspaceInternalBash: true,
      }).assess(call, ctx),
    ).toMatchObject({ decision: 'unavailable' });
    const policy = new PolicyToolRegistry(inner, {
      tools: {},
      onAsk: 'ask',
      allowWorkspaceInternalBash: true,
    });
    expect((await policy.execute(call, ctx)).isError).toBe(false);
    expect(await readFile(path.join(root, 'dest'), 'utf8')).toBe('data');
    expect(await policy.assess(call, ctx)).toMatchObject({ decision: 'unavailable' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('runs the acceptance checks through remote argv without a local fallback', async () => {
  const { RemoteSandbox } = await import('../src/sandbox/remote-sandbox.js');
  const { checkWorkspaceCopy } = await import('../../../scripts/check-workspace-copy.js');
  const { guestValueSchema } = await import('@trinity-harness/contracts');
  const root = await mkdtemp(path.join(tmpdir(), 'copy-remote-'));
  const local = new LocalSandbox(root);
  const controller = new AbortController();
  const operations: string[] = [];
  try {
    const remote = new RemoteSandbox(
      {
        call: async (_session, op, signal) => {
          signal?.throwIfAborted();
          operations.push(op.kind);
          if (op.kind === 'exec') {
            if (!op.args) throw Error('Shell fallback forbidden');
            const value = await local.execArgv(op.command, op.args, {
              ...op.options,
              maxOutputBytes: op.maxOutputBytes,
              signal,
            });
            return guestValueSchema.parse({ kind: 'exec', ...value });
          }
          if (op.kind === 'write') {
            await local.writeFile(op.path, op.content);
            return { kind: 'ok' };
          }
          if (op.kind === 'read')
            return guestValueSchema.parse({
              kind: 'read',
              ...(await local.readFile(op.path, { maxBytes: op.maxBytes, signal })),
            });
          throw Error('Unexpected route');
        },
      },
      'session',
    );
    await checkWorkspaceCopy(remote, controller.signal);
    expect(operations).toContain('exec');
    expect(operations).toContain('read');
    expect(operations).toContain('write');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
