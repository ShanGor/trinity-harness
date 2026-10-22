import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { SessionMeta, SessionMetaStore } from '@trinity-harness/contracts';

/** Allocate only server-generated session paths beneath the shared deployment disk. */
export async function chatWorkspaceDir(
  root: string,
  userId: string,
  sessionId: string,
): Promise<string> {
  if (userId !== 'anonymous') z.uuid().parse(userId);
  z.uuid().parse(sessionId);
  await mkdir(root, { recursive: true });
  let directory = await realpath(root);
  for (const segment of ['sessions', userId, sessionId]) {
    directory = path.join(directory, segment);
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid Chat workspace directory');
  }
  return directory;
}

/** Never let a legacy null-workspace Chat inherit the deployment sandbox. */
export async function sessionWorkspaceRoot(
  meta: SessionMeta | null | undefined,
  deploymentRoot: string,
  metas?: SessionMetaStore,
): Promise<string> {
  if (meta?.closedAt) throw new Error('Session closed');
  if (meta?.kind !== 'chat') return meta?.workspaceUri ?? deploymentRoot;
  const directory = await chatWorkspaceDir(deploymentRoot, meta.userId, meta.id);
  if (meta.workspaceUri !== null) {
    if (meta.workspaceUri !== directory) throw new Error('Chat workspace binding mismatch');
    return directory;
  }
  if (!metas?.bindChatWorkspace) throw new Error('Chat workspace binding unavailable');
  const bound = await metas.bindChatWorkspace(meta.id, directory);
  if (bound.workspaceUri !== directory) throw new Error('Chat workspace binding mismatch');
  return directory;
}

/** Keep a writable copy without trusting uploaded names as filesystem paths. */
export async function saveWorkspaceAttachment(
  workspaceRoot: string,
  data: Uint8Array,
  filename = 'attachment',
): Promise<string> {
  const directory = path.join(workspaceRoot, 'uploads');
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid uploads directory');
  const name = filename.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120);
  const relative = `uploads/${randomUUID()}-${name}`;
  await writeFile(path.join(workspaceRoot, relative), data, { flag: 'wx', mode: 0o600 });
  return relative;
}
