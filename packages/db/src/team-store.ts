import type { Team, TeamRole, TeamStore } from '@trinity-harness/contracts';
import { and, eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { teamMembers, teams, users } from './schema.js';

function toTeam(row: typeof teams.$inferSelect): Team {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/** PostgreSQL-backed {@link TeamStore} (docs/design.md §15 `teams`). */
export class PgTeamStore implements TeamStore {
  constructor(private readonly db: Db) {}

  async create(input: { tenantId: string; name: string; ownerId: string }): Promise<Team> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(teams)
        .values({ tenantId: input.tenantId, name: input.name })
        .returning();
      if (!row) throw new Error('team insert returned no row');
      await tx.insert(teamMembers).values({ teamId: row.id, userId: input.ownerId, role: 'owner' });
      return toTeam(row);
    });
  }

  async get(teamId: string): Promise<Team | null> {
    const [row] = await this.db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    return row ? toTeam(row) : null;
  }

  async listForUser(userId: string): Promise<Team[]> {
    const rows = await this.db
      .select({ team: teams })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, userId));
    return rows.map((r) => toTeam(r.team));
  }

  async addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await this.db.insert(teamMembers).values({ teamId, userId, role });
  }

  async isMember(teamId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1);
    return row !== undefined;
  }

  async listMembers(
    teamId: string,
  ): Promise<{ userId: string; email: string; role: TeamRole; createdAt: string }[]> {
    const rows = await this.db
      .select({
        userId: teamMembers.userId,
        email: users.email,
        role: teamMembers.role,
        createdAt: teamMembers.createdAt,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.teamId, teamId));
    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      role: r.role as TeamRole,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  async isOwner(teamId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1);
    return row?.role === 'owner';
  }
}
