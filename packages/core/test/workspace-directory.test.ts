import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LocalSandbox } from '../src/sandbox/local-sandbox.js';
import { RemoteSandbox } from '../src/sandbox/remote-sandbox.js';
import { guestOperationSchema, guestValueSchema } from '@trinity-harness/contracts';

it('caps immediate listings, shows empty directories, and honours cancellation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-directory-'));
  const sandbox = new LocalSandbox(root);
  try {
    expect(await sandbox.listDirectory('')).toEqual({ entries: [], truncated: false });
    await Promise.all(
      Array.from({ length: 501 }, (_, i) => writeFile(path.join(root, `${i}.txt`), '')),
    );
    const result = await sandbox.listDirectory('');
    expect(result.entries).toHaveLength(500);
    expect(result.truncated).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(sandbox.listDirectory('', controller.signal)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('browses and previews through existing guest exec with bounded text and contained paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trinity-remote-directory-'));
  const local = new LocalSandbox(directory);
  const controller = new AbortController();
  const sandbox = new RemoteSandbox(
    {
      call: async (sessionId, input, signal) => {
        expect(sessionId).toBe('session');
        const operation = guestOperationSchema.parse(input);
        expect(operation.kind).toBe('exec');
        expect(signal).toBe(controller.signal);
        if (operation.kind !== 'exec' || !operation.args) throw new Error('Expected argv exec');
        const value = await local.execArgv(operation.command, operation.args, {
          ...operation.options,
          signal,
          maxOutputBytes: operation.maxOutputBytes,
        });
        return guestValueSchema.parse({ kind: 'exec', ...value });
      },
    },
    'session',
  );
  try {
    const name = "notes '; $(touch unsafe)";
    await mkdir(path.join(directory, name));
    await mkdir(path.join(directory, name, 'empty'));
    await mkdir(path.join(directory, 'model-context'));
    await symlink(tmpdir(), path.join(directory, 'outside'));
    expect(await sandbox.listDirectory(name, controller.signal)).toEqual({
      entries: [{ name: 'empty', kind: 'directory' }],
      truncated: false,
    });
    expect((await sandbox.listDirectory('', controller.signal)).entries).toEqual([
      { name, kind: 'directory' },
      { name: 'outside', kind: 'other' },
    ]);
    await expect(sandbox.listDirectory('outside', controller.signal)).rejects.toThrow(
      'unavailable',
    );
    await expect(sandbox.listDirectory('../outside', controller.signal)).rejects.toThrow();
    await expect(sandbox.listDirectory('model-context', controller.signal)).rejects.toThrow();
    await writeFile(path.join(directory, 'preview.txt'), 'first\n<script>escaped</script>');
    expect(await sandbox.previewFile('preview.txt', controller.signal)).toEqual({
      content: 'first\n<script>escaped</script>',
      truncated: false,
      offset: 1,
    });
    await writeFile(path.join(directory, 'lines.txt'), 'line\n'.repeat(3000));
    const lines = await sandbox.previewFile('lines.txt', controller.signal);
    expect(lines.content).toBe('line\n'.repeat(2000));
    expect(lines.truncated).toBe(true);
    await writeFile(path.join(directory, 'unicode.txt'), '😀'.repeat(20000));
    const unicode = await sandbox.previewFile('unicode.txt', controller.signal);
    expect(Buffer.byteLength(unicode.content)).toBeLessThanOrEqual(65536);
    expect(unicode.content).not.toContain('�');
    expect(unicode.truncated).toBe(true);
    await expect(sandbox.previewFile('outside/escape.txt', controller.signal)).rejects.toThrow(
      'unavailable',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
