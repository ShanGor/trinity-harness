import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { RemoteSandbox } from '../src/sandbox/remote-sandbox.js';
import { guestOperationSchema, guestValueSchema } from '@trinity-harness/contracts';
import { LocalSandbox } from '../src/sandbox/local-sandbox.js';

it.each(['local', 'remote'])(
  'retains revisions across adapter recreation and rejects stale saves, binary edits and symlinks',
  async (driver) => {
    const root = await mkdtemp(path.join(tmpdir(), 'workspace-document-'));
    const local = new LocalSandbox(root);
    const sandbox =
      driver === 'local'
        ? local
        : new RemoteSandbox(
            {
              call: async (_session, input, signal) => {
                const operation = guestOperationSchema.parse(input);
                if (operation.kind === 'writeBytes') {
                  await local.writeBytes(operation.path, Buffer.from(operation.data, 'base64'));
                  return { kind: 'ok' };
                }
                if (operation.kind === 'remove') {
                  await local.removeFile(operation.path);
                  return { kind: 'ok' };
                }
                if (operation.kind !== 'exec' || !operation.args)
                  throw new Error('Expected argv exec');
                return guestValueSchema.parse({
                  kind: 'exec',
                  ...(await local.execArgv(operation.command, operation.args, {
                    ...operation.options,
                    signal,
                    maxOutputBytes: operation.maxOutputBytes,
                  })),
                });
              },
            },
            'test-session',
          );
    try {
      await writeFile(path.join(root, 'a.txt'), 'before\n');
      const original = await sandbox.workspaceDocument({ operation: 'read', path: 'a.txt' });
      expect(original.text).toBe('before\n');
      const saved = await sandbox.workspaceDocument({
        operation: 'save',
        path: 'a.txt',
        expectedVersion: original.version!,
        content: 'after\n',
      });
      expect(saved.version).not.toBe(original.version);
      expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('after\n');
      await expect(
        sandbox.workspaceDocument({
          operation: 'save',
          path: 'a.txt',
          expectedVersion: original.version!,
          content: 'stale',
        }),
      ).rejects.toThrow('changed');
      const restored = new LocalSandbox(root);
      const history = await restored.workspaceDocument({ operation: 'history', path: 'a.txt' });
      expect(history.revisions).toHaveLength(2);
      expect(
        await restored.workspaceDocument({
          operation: 'read',
          path: 'a.txt',
          revision: original.version!,
        }),
      ).toEqual({ version: original.version, text: 'before\n' });
      const full = '你'.repeat(700000);
      await sandbox.workspaceDocument({
        operation: 'save',
        path: 'a.txt',
        expectedVersion: saved.version!,
        content: full,
      });
      expect((await sandbox.workspaceDocument({ operation: 'read', path: 'a.txt' })).text).toBe(
        full,
      );
      await symlink('a.txt', path.join(root, 'link'));
      await expect(
        sandbox.workspaceDocument({ operation: 'read', path: 'link' }),
      ).rejects.toThrow();
      await mkdir(path.join(root, 'nested'));
      await symlink(root, path.join(root, 'nested', 'outside'));
      await expect(
        sandbox.workspaceDocument({ operation: 'read', path: 'nested/outside/a.txt' }),
      ).rejects.toThrow();
      await expect(
        sandbox.workspaceDocument({ operation: 'read', path: 'model-context/workspace-revisions' }),
      ).rejects.toThrow();
      await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 255]));
      const binary = await sandbox.workspaceDocument({ operation: 'read', path: 'binary' });
      expect(binary.text).toBeUndefined();
      expect(Buffer.from(binary.base64!, 'base64')).toEqual(Buffer.from([0, 1, 255]));
      await expect(
        sandbox.workspaceDocument({
          operation: 'save',
          path: 'binary',
          expectedVersion: binary.version!,
          content: 'bad',
        }),
      ).rejects.toThrow();
      await writeFile(path.join(root, 'large'), 'a'.repeat(65537));
      expect(
        (await sandbox.workspaceDocument({ operation: 'read', path: 'large' })).text,
      ).toHaveLength(65537);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
