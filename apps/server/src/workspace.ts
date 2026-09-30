import path from 'node:path';

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
