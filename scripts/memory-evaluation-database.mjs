import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Pool } = require('pg');

/** Check before migrations, and again before seeding; never print connection strings. */
export async function assertDisposableDatabase(target, configured) {
  const identity = async (pool) =>
    (
      await pool.query(`select current_database() as database,
      extract(epoch from pg_postmaster_start_time())::text as cluster_started`)
    ).rows[0];
  const selected = await identity(target);
  if (configured) {
    const current = await identity(configured);
    if (
      current.database === selected.database &&
      current.cluster_started === selected.cluster_started
    )
      throw new Error('MEMORY_EVAL_CONFIGURED_DATABASE');
  }
  const tables = await target.query(`select schemaname, tablename from pg_tables
    where schemaname not in ('pg_catalog', 'information_schema', 'drizzle')
    and left(schemaname, 3) <> 'pg_'`);
  if (tables.rows.length > 256) throw new Error('MEMORY_EVAL_DATABASE_NOT_EMPTY');
  const quote = (identifier) => '"' + identifier.replaceAll('"', '""') + '"';
  for (const row of tables.rows) {
    const result = await target.query(
      `select exists(select 1 from ${quote(row.schemaname)}.${quote(row.tablename)} limit 1) as populated`,
    );
    if (result.rows[0]?.populated !== false) throw new Error('MEMORY_EVAL_DATABASE_NOT_EMPTY');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  require('dotenv').config({ quiet: true });
  const url = process.env.TRINITY_MEMORY_TEST_DATABASE_URL;
  const configuredUrl = process.env.DATABASE_URL;
  const pools = [];
  try {
    if (!url) throw new Error('MEMORY_EVAL_DATABASE_REQUIRED');
    const target = new Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
    pools.push(target);
    // An unavailable configured database cannot prove that the target is separate.
    const configured = configuredUrl
      ? new Pool({ connectionString: configuredUrl, connectionTimeoutMillis: 2000 })
      : undefined;
    if (configured) pools.push(configured);
    await assertDisposableDatabase(target, configured);
    console.info('MEMORY_EVAL_DATABASE_PREFLIGHT_OK');
  } catch (error) {
    console.error(
      error instanceof Error && /^MEMORY_EVAL_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'MEMORY_EVAL_DATABASE_PREFLIGHT_UNAVAILABLE',
    );
    process.exitCode = 1;
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}
