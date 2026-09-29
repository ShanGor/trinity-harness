import type { Identity, PasswordHasher, Role, User, UserStore } from '@trinity-harness/contracts';
import { asc, eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { users } from './schema.js';

function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    role: row.role as Role,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/** PostgreSQL-backed {@link UserStore} (docs/design.md §15 `users`). */
export class PgUserStore implements UserStore {
  constructor(
    private readonly db: Db,
    private readonly hasher: PasswordHasher,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return row ? toUser(row) : null;
  }

  async findById(userId: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row ? toUser(row) : null;
  }

  async verifyCredentials(email: string, password: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!row) {
      // Fail-closed without an oracle: burn comparable work on unknown users.
      await this.hasher.verify(password, '$scrypt$unknown$unknown');
      return null;
    }
    const ok = await this.hasher.verify(password, row.passwordHash);
    return ok ? toUser(row) : null;
  }

  async createUser(input: {
    tenantId: string;
    email: string;
    passwordHash: string;
    role: Role;
  }): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({
        tenantId: input.tenantId,
        email: input.email,
        passwordHash: input.passwordHash,
        role: input.role,
      })
      .returning();
    if (!row) {
      throw new Error('createUser: no row returned');
    }
    return toUser(row);
  }

  async listByTenant(tenantId: string): Promise<User[]> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(asc(users.createdAt), asc(users.email));
    return rows.map(toUser);
  }
}

/** Bootstrap guard: is this a first boot (no users at all)? */
export async function countUsers(db: Db): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length;
}

export function identityOf(user: User): Identity {
  return { userId: user.id, tenantId: user.tenantId, role: user.role };
}
