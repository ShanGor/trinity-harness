import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createPool(
  databaseUrl: string,
  options?: Omit<pg.PoolConfig, 'connectionString'>,
): pg.Pool {
  return new pg.Pool({ ...options, connectionString: databaseUrl });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}
