import { z } from 'zod';

/**
 * Team workspaces (docs/design.md §15 `teams` / `team_members`).
 *
 * A team is a tenant-scoped group of users sharing one workspace directory
 * (`$WORKSPACE_ROOT/<team_id>`); every user also has a personal workspace
 * (`$WORKSPACE_ROOT/<user_id>`). A user may belong to many teams. Session
 * creation binds a session to a scope; tool execution is sandboxed to that
 * directory, so scope membership checks are a fail-closed security boundary.
 */

export const teamSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamRoleSchema = z.enum(['owner', 'member']);
export type TeamRole = z.infer<typeof teamRoleSchema>;

export const teamMemberSchema = z.object({
  teamId: z.uuid(),
  userId: z.uuid(),
  role: teamRoleSchema,
  createdAt: z.iso.datetime(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

/** Team directory (docs/design.md §15). */
export interface TeamStore {
  /** Creates the team and enrolls `ownerId` as 'owner' (atomic). */
  create(input: { tenantId: string; name: string; ownerId: string }): Promise<Team>;
  get(teamId: string): Promise<Team | null>;
  /** All teams (any tenant) the user belongs to. */
  listForUser(userId: string): Promise<Team[]>;
  addMember(teamId: string, userId: string, role: TeamRole): Promise<void>;
  /** Membership check — the fail-closed gate for team workspaces. */
  isMember(teamId: string, userId: string): Promise<boolean>;
  /** Members with emails, for the team management UI. */
  listMembers(
    teamId: string,
  ): Promise<{ userId: string; email: string; role: TeamRole; createdAt: string }[]>;
  /** Owner check — gates member administration. */
  isOwner(teamId: string, userId: string): Promise<boolean>;
}
