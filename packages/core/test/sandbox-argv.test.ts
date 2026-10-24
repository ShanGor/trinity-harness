import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LocalSandbox } from '../src/index.js';
it('executes literal argv without shell expansion and enforces a combined transport cap', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-argv-'));
  try {
    const sandbox = new LocalSandbox(root);
    const literal = '$(echo secret); `echo secret`';
    const result = await sandbox.execArgv(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', literal],
      { maxOutputBytes: 100 },
    );
    expect(result).toMatchObject({
      stdout: literal,
      stderr: '',
      exitCode: 0,
      outputOverflow: false,
    });
    const overflow = await sandbox.execArgv(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(10000));process.stderr.write("y".repeat(10000))'],
      { maxOutputBytes: 1024 },
    );
    expect(overflow.outputOverflow).toBe(true);
    expect(
      Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr),
    ).toBeLessThanOrEqual(1024);
    expect(overflow.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds binary reads before allocation and refuses symlink captures', async () => {
  const { writeFile, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-binary-'));
  try {
    const sandbox = new LocalSandbox(root);
    await writeFile(path.join(root, 'capture.png'), Buffer.alloc(10));
    expect(await sandbox.readBytes('capture.png', 10)).toHaveLength(10);
    await expect(sandbox.readBytes('capture.png', 9)).rejects.toThrow('limit');
    await symlink(path.join(root, 'capture.png'), path.join(root, 'link.png'));
    await expect(sandbox.readBytes('link.png', 10)).rejects.toThrow();
    await sandbox.removeFile('capture.png');
    await expect(sandbox.readBytes('capture.png', 10)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('writes binary uploads within the workspace and rejects symlink directories and escaping paths', async () => {
  const { readFile, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-binary-write-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'trinity-binary-outside-'));
  try {
    const sandbox = new LocalSandbox(root);
    const bytes = new Uint8Array([0, 255, 10]);
    await sandbox.writeBytes('uploads/file.bin', bytes);
    expect(await readFile(path.join(root, 'uploads/file.bin'))).toEqual(Buffer.from(bytes));
    await symlink(outside, path.join(root, 'linked'));
    await expect(sandbox.writeBytes('linked/file.bin', bytes)).rejects.toThrow('Unsafe');
    await expect(sandbox.writeBytes('../escape.bin', bytes)).rejects.toThrow('escapes');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
