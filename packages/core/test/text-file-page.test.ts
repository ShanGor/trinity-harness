import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LocalSandbox } from '../src/sandbox/local-sandbox.js';
import { readTextFilePage, type TextFileSource } from '../src/sandbox/text-file-page.js';

function source(text: string): TextFileSource & { positions: number[] } {
  const bytes = Buffer.from(text);
  const positions: number[] = [];
  return {
    size: bytes.length,
    version: createHash('sha256').update(bytes).digest('hex'),
    positions,
    read: async (position, length) => {
      positions.push(position);
      return bytes.subarray(position, position + length);
    },
    assertUnchanged: async () => {},
  };
}

it('round-trips long Unicode lines without gaps and resumes directly at byte positions', async () => {
  const text = '汉🙂abc'.repeat(20) + '\nsecond\n';
  const file = source(text);
  let page = await readTextFilePage(file, { maxBytes: 7 });
  let content = page.content;
  expect(page.totalLines).toBeUndefined();
  expect(page.endsMidLine).toBe(true);
  while (page.continuation) {
    const cursor = page.continuation;
    const before = file.positions.length;
    page = await readTextFilePage(file, { maxBytes: 7, cursor });
    expect(file.positions[before]).toBe(cursor.byteOffset);
    content += page.content;
  }
  expect(content).toBe(text);
  expect(page.totalLines).toBe(2);
});

it('selects lines, preserves newlines, and returns EOF without scanning the rest for totals', async () => {
  const file = source('one\ntwo\nthree\nfour');
  const page = await readTextFilePage(file, { offset: 2, limit: 1 });
  expect(page).toMatchObject({ content: 'two\n', offset: 2, nextOffset: 3, truncated: true });
  expect(page.totalLines).toBeUndefined();
  expect(await readTextFilePage(file, { cursor: page.continuation })).toMatchObject({
    content: 'three\nfour',
    totalLines: 4,
    truncated: false,
  });
  expect(await readTextFilePage(source(''))).toMatchObject({ content: '', totalLines: 0 });
});

it('bounds reads independently of file size and checks cancellation while skipping a prefix', async () => {
  const controller = new AbortController();
  let requested = 0;
  const file: TextFileSource = {
    size: 500 * 1024 * 1024,
    version: 'a'.repeat(64),
    read: async (_position, length) => {
      requested += length;
      return Buffer.alloc(length, 120);
    },
    assertUnchanged: async () => {},
  };
  expect((await readTextFilePage(file)).content.length).toBe(64 * 1024);
  expect(requested).toBe(64 * 1024 + 4);
  file.read = async (_position, length) => {
    controller.abort();
    return Buffer.alloc(length, 120);
  };
  await expect(readTextFilePage(file, { offset: 2, signal: controller.signal })).rejects.toThrow();
});

it('reads files above 5 MiB and rejects cursors after edits or path replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-text-'));
  try {
    const target = path.join(root, 'large.txt');
    await writeFile(target, 'x'.repeat(6 * 1024 * 1024));
    const sandbox = new LocalSandbox(root);
    const page = await sandbox.readFile('large.txt', { maxBytes: 1024 });
    expect(page.content.length).toBe(1024);
    expect(
      await sandbox.readFile('large.txt', { cursor: page.continuation, maxBytes: 1024 }),
    ).toMatchObject({ content: 'x'.repeat(1024), startsMidLine: true });
    await writeFile(target, 'changed');
    await expect(sandbox.readFile('large.txt', { cursor: page.continuation })).rejects.toThrow(
      'STALE_FILE_CURSOR',
    );
    const fresh = await sandbox.readFile('large.txt', { maxBytes: 4 });
    await writeFile(path.join(root, 'replacement'), 'changed');
    await rename(path.join(root, 'replacement'), target);
    await expect(sandbox.readFile('large.txt', { cursor: fresh.continuation })).rejects.toThrow(
      'STALE_FILE_CURSOR',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a page changed during capture and invalid UTF-8 instead of fabricating text', async () => {
  const file = source('example');
  file.assertUnchanged = async () => {
    throw new Error('FILE_CHANGED');
  };
  await expect(readTextFilePage(file)).rejects.toThrow('FILE_CHANGED');
  const binary = source('example');
  binary.read = async () => Uint8Array.of(255, 255, 255, 255, 255, 255, 255);
  await expect(readTextFilePage(binary)).rejects.toThrow();
});
