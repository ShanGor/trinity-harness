import { z } from 'zod';

import type { PermissionPolicy } from './approval.js';

/**
 * Identity & tenant contracts (docs/design.md §5.1 `Identity & Tenant`, §12.4).
 * Roles are coarse-grained RBAC scopes enforced at the API layer (M2):
 * - `admin`: tenant administration (user provisioning, audit query);
 * - `developer`: full agent usage (create/run sessions);
 * - `viewer`: read-only.
 */

export const roleSchema = z.enum(['admin', 'developer', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

/** Authenticated principal, attached to the request after token verification. */
export interface Identity {
  userId: string;
  tenantId: string;
  role: Role;
}

export const userSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  email: z.string().email(),
  role: roleSchema,
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const sessionMetaSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  userId: z.uuid(),
  title: z.string().max(200),
  workspaceUri: z.string().min(1),
  /**
   * Workspace scope: 'personal' → `$WORKSPACE_ROOT/<userId>`, 'team' →
   * `$WORKSPACE_ROOT/<scopeId>` (docs/design.md §15; sandboxed per session).
   */
  scope: z.enum(['personal', 'team']).optional(),
  /** Team id when scope === 'team'. */
  scopeId: z.uuid().optional(),
  /** M3: per-session permission policy (preset name or JSON policy). */
  policy: z.string().max(4000).optional(),
  forkedFrom: z.uuid().optional(),
  createdAt: z.iso.datetime(),
  closedAt: z.iso.datetime().optional(),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

/** Password hashing is a port so stores stay dumb and hasher stays swappable. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
}

/** User directory (per-tenant). */
export interface UserStore {
  findByEmail(email: string): Promise<User | null>;
  findById(userId: string): Promise<User | null>;
  /**
   * Login verification: looks up by email and checks the password with the
   * store's injected {@link PasswordHasher}. Returns null for unknown email OR
   * wrong password (fail-closed, no oracle — same code path both ways).
   */
  verifyCredentials(email: string, password: string): Promise<User | null>;
  createUser(input: {
    tenantId: string;
    email: string;
    passwordHash: string;
    role: Role;
  }): Promise<User>;
  /** Tenant-scoped listing; admin endpoints only. */
  listByTenant(tenantId: string): Promise<User[]>;
}

/**
 * Session metadata/ownership (docs/design.md §15 `sessions` table). The event
 * log (SessionStore) is keyed by session id; this store answers "who owns it".
 */
export interface SessionMetaStore {
  create(meta: Omit<SessionMeta, 'createdAt'>): Promise<void>;
  get(sessionId: string): Promise<SessionMeta | null>;
  /** Own sessions for developer/viewer; whole tenant for admin. */
  listForIdentity(identity: Identity): Promise<SessionMeta[]>;
  /** Fill the title from the first prompt when a session began with an upload. */
  setTitleIfEmpty(sessionId: string, title: string): Promise<void>;
  /** Hide a session from history and deny future access; preserve its event log. */
  close(sessionId: string): Promise<void>;
  /** M3: update the permission policy (session/set_config_option). */
  setPolicy(sessionId: string, policy: PermissionPolicy | string): Promise<void>;
}

/**
 * Signed bearer-token service (docs/design.md §12.4: secrets server-side).
 * `verify` returns null for any invalid/expired token — callers fail closed.
 */
export interface TokenService {
  issue(identity: Identity): Promise<string>;
  verify(token: string): Promise<Identity | null>;
}
