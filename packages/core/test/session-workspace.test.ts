import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionMeta, SessionMetaStore } from '@trinity-harness/contracts';
import { chatWorkspaceDir, saveWorkspaceAttachment, sessionWorkspaceRoot } from '../src/index.js';
import { toModelMessages } from '../src/loop/to-model-messages.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'trinity-chat-workspace-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('isolates session and owner folders, survives retries, and rejects traversal and symlinks', async () => {
  const directory = await root();
  const owner = randomUUID();
  const id = randomUUID();
  const workspace = await chatWorkspaceDir(directory, owner, id);
  expect(await chatWorkspaceDir(directory, owner, id)).toBe(workspace);
  expect(await chatWorkspaceDir(directory, randomUUID(), id)).not.toBe(workspace);
  expect(await chatWorkspaceDir(directory, owner, randomUUID())).not.toBe(workspace);
  await expect(chatWorkspaceDir(directory, '../escape', id)).rejects.toThrow();
  const linked = randomUUID();
  await symlink(await root(), path.join(directory, 'sessions', owner, linked));
  await expect(chatWorkspaceDir(directory, owner, linked)).rejects.toThrow('Invalid Chat');
});

it('binds legacy metadata before use and fails closed without a durable binder', async () => {
  const directory = await root();
  const meta: SessionMeta = {
    id: randomUUID(),
    userId: randomUUID(),
    tenantId: randomUUID(),
    title: '',
    kind: 'chat',
    sessionRole: 'side',
    workspaceUri: null,
    createdAt: '2026-10-21T00:00:00.000Z',
  };
  await expect(sessionWorkspaceRoot(meta, directory)).rejects.toThrow('binding unavailable');
  const bindChatWorkspace = vi.fn(async (_id: string, workspaceUri: string) => ({
    ...meta,
    workspaceUri,
  }));
  const metas = { bindChatWorkspace } as unknown as SessionMetaStore;
  const workspace = await sessionWorkspaceRoot(meta, directory, metas);
  expect(bindChatWorkspace).toHaveBeenCalledWith(meta.id, workspace);
  expect(await sessionWorkspaceRoot({ ...meta, workspaceUri: workspace }, directory, metas)).toBe(
    workspace,
  );
  expect(bindChatWorkspace).toHaveBeenCalledTimes(1);
  await expect(
    sessionWorkspaceRoot({ ...meta, workspaceUri: '/elsewhere' }, directory, metas),
  ).rejects.toThrow('mismatch');
  await expect(
    sessionWorkspaceRoot({ ...meta, closedAt: meta.createdAt }, directory, metas),
  ).rejects.toThrow('closed');
  expect(
    await sessionWorkspaceRoot({ ...meta, kind: 'work', workspaceUri: '/project' }, directory),
  ).toBe('/project');
});

it('copies uploads safely and replays their exact file reference without loading bytes into context', async () => {
  const directory = await root();
  const data = Buffer.from('x'.repeat(200_000));
  const workspacePath = await saveWorkspaceAttachment(directory, data, '../../report.pdf');
  expect(workspacePath).toMatch(/^uploads\/[a-f0-9-]+-.._.._report.pdf$/);
  expect(await readFile(path.join(directory, workspacePath))).toEqual(data);
  const at = '2026-10-21T00:00:00.000Z';
  const messages = toModelMessages([
    {
      type: 'session/attachment',
      eventId: randomUUID(),
      at,
      uri: 'blob://mine',
      workspacePath,
      size: data.length,
      mimeType: 'application/pdf',
    },
    {
      type: 'message/user',
      eventId: randomUUID(),
      at,
      surfaceOp: 'append',
      content: [
        { kind: 'text', text: 'Inspect the uploaded document' },
        { kind: 'file', uri: 'blob://mine' },
      ],
    },
  ]);
  expect(messages[0]?.content).toContain(workspacePath);
  expect(JSON.stringify(messages)).not.toContain('x'.repeat(100));
  const outside = await root();
  const untrusted = await root();
  await mkdir(path.join(untrusted, 'safe'));
  await symlink(outside, path.join(untrusted, 'uploads'));
  await expect(saveWorkspaceAttachment(untrusted, data, 'unsafe.pdf')).rejects.toThrow(
    'Invalid uploads',
  );
  expect(await readdir(outside)).toEqual([]);
});
