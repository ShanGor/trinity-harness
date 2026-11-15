import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { inflateRawSync, crc32 } from 'node:zlib';
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
      await mkdir(path.join(root, 'nested', 'empty'));
      await writeFile(path.join(root, 'nested', '你好.txt'), 'Unicode content');
      await writeFile(path.join(root, '.hidden'), 'hidden');
      const archive = await sandbox.workspaceDocument({ operation: 'archive', path: '' });
      const entries = unzip(archive.base64!);
      expect(entries.get('nested/你好.txt')?.toString()).toBe('Unicode content');
      expect(entries.get('nested/empty/')).toEqual(Buffer.alloc(0));
      expect(entries.get('binary')).toEqual(Buffer.from([0, 1, 255]));
      expect(entries.get('.hidden')?.toString()).toBe('hidden');
      expect(
        [...entries.keys()].some(
          (name) => name.includes('model-context') || name.includes('outside') || name === 'link',
        ),
      ).toBe(false);
      const nested = unzip(
        (await sandbox.workspaceDocument({ operation: 'archive', path: 'nested' })).base64!,
      );
      expect([...nested.keys()].sort()).toEqual(['empty/', '你好.txt']);
      expect(
        unzip(
          (await sandbox.workspaceDocument({ operation: 'archive', path: 'nested/empty' })).base64!,
        ).size,
      ).toBe(0);
      for (const invalid of ['../escape', 'model-context', 'nested/outside', 'a.txt']) {
        await expect(
          sandbox.workspaceDocument({ operation: 'archive', path: invalid }),
        ).rejects.toThrow();
      }
      await writeFile(path.join(root, 'too-large'), Buffer.alloc(5 * 1024 * 1024 + 1));
      await expect(sandbox.workspaceDocument({ operation: 'archive', path: '' })).rejects.toThrow();
      await rm(path.join(root, 'too-large'));
      // Individually permitted files still obey the combined input bound.
      await writeFile(path.join(root, 'aggregate'), Buffer.alloc(4 * 1024 * 1024));
      await expect(sandbox.workspaceDocument({ operation: 'archive', path: '' })).rejects.toThrow();
      await rm(path.join(root, 'aggregate'));
      await mkdir(path.join(root, 'deep', ...Array.from({ length: 33 }, () => 'a')), {
        recursive: true,
      });
      await expect(
        sandbox.workspaceDocument({ operation: 'archive', path: 'deep' }),
      ).rejects.toThrow('depth limit');

      await Promise.all(
        Array.from({ length: 1001 }, (_, index) =>
          writeFile(path.join(root, 'nested', String(index)), ''),
        ),
      );
      await expect(
        sandbox.workspaceDocument({ operation: 'archive', path: 'nested' }),
      ).rejects.toThrow('entry limit');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/** Read ZIP central records and inflate their local entries independently of the writer. */
function unzip(base64: string): Map<string, Buffer> {
  const zip = Buffer.from(base64, 'base64');
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  let cursor = zip.readUInt32LE(end + 16);
  const result = new Map<string, Buffer>();
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(zip.readUInt16LE(cursor + 8)).toBe(0x800);
    const length = zip.readUInt16LE(cursor + 28);
    const name = zip.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    const local = zip.readUInt32LE(cursor + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(start, start + zip.readUInt32LE(cursor + 20));
    const data = zip.readUInt16LE(cursor + 10) === 8 ? inflateRawSync(compressed) : compressed;
    expect(data.length).toBe(zip.readUInt32LE(cursor + 24));
    expect(crc32(data)).toBe(zip.readUInt32LE(cursor + 16));
    result.set(name, data);
    cursor += 46 + length + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  expect(cursor).toBe(end);
  return result;
}
