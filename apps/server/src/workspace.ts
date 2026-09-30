import path from 'node:path';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';

/**
 * Per-session workspace directories (docs/design.md §15): every session is
 * sandboxed to exactly one directory under the deployment root —
 * `$WORKSPACE_ROOT/<user_id>` (personal) or `$WORKSPACE_ROOT/<team_id>`
 * (team). Path traversal is rejected (fail-closed, AGENTS.md §5).
 */

export type WorkspaceScope = 'personal' | 'team';

/** Resolves the sandbox directory for a scope; rejects anything outside the root. */
export function workspaceDirFor(root: string, scope: WorkspaceScope, scopeId: string): string {
  const base = path.resolve(root);
  const dir = path.resolve(base, scopeId);
  if (dir !== base && !dir.startsWith(base + path.sep)) {
    throw new Error(`workspace escapes root: ${scope}/${scopeId}`);
  }
  return dir;
}

/** A relative folder name below the user's personal root; empty selects the root. */
export function personalFolderSegments(folderPath: string): string[] {
  if (folderPath === '') return [];
  if (
    folderPath.length > 500 ||
    path.isAbsolute(folderPath) ||
    folderPath.includes('\\') ||
    folderPath.includes('\0')
  ) {
    throw new Error('invalid personal workspace folder');
  }
  const segments = folderPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('invalid personal workspace folder');
  }
  return segments;
}

/** Resolve an existing directory without following symlinks out of the user's root. */
export async function personalWorkspaceDir(
  root: string,
  userId: string,
  folderPath = '',
): Promise<string> {
  const segments = personalFolderSegments(folderPath);
  const userRoot = workspaceDirFor(root, 'personal', userId);
  await mkdir(userRoot, { recursive: true });
  let current = await realpath(userRoot);
  const deploymentRoot = await realpath(root);
  if (current !== path.join(deploymentRoot, userId)) {
    throw new Error('invalid personal workspace root');
  }
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('personal workspace folder is not a directory');
    }
  }
  return current;
}

/** List immediate directories so the picker can browse arbitrarily deep. */
export async function listPersonalFolders(
  root: string,
  userId: string,
  folderPath = '',
): Promise<string[]> {
  const directory = await personalWorkspaceDir(root, userId, folderPath);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}
