import { eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { tenants } from './schema.js';

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

/** Bootstrap helper: default tenant creation at server startup / seeding. */
export async function createTenant(db: Db, name: string): Promise<Tenant> {
  const [row] = await db.insert(tenants).values({ name }).returning();
  if (!row) throw new Error('createTenant: no row returned');
  return { id: row.id, name: row.name, createdAt: new Date(row.createdAt).toISOString() };
}

export async function getTenant(db: Db, tenantId: string): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return row
    ? { id: row.id, name: row.name, createdAt: new Date(row.createdAt).toISOString() }
    : null;
}
