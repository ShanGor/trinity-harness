import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDisposableDatabase } from './memory-evaluation-database.mjs';

function pool(database, tables = [], populated = false) {
  return {
    queries: [],
    async query(sql) {
      this.queries.push(sql);
      if (sql.includes('current_database()'))
        return { rows: [{ database, cluster_started: '2026-11-24 00:00:00+00' }] };
      if (sql.includes('from pg_tables')) return { rows: tables };
      return { rows: [{ populated }] };
    },
  };
}

test('allows a fresh database and an already migrated empty database', async () => {
  await assertDisposableDatabase(pool('evaluation'), pool('application'));
  await assertDisposableDatabase(
    pool('evaluation', [{ schemaname: 'public', tablename: 'sessions' }]),
    pool('application'),
  );
});
test('refuses the configured database even if it has no sessions', async () => {
  const target = pool('application');
  await assert.rejects(
    assertDisposableDatabase(target, pool('application')),
    /MEMORY_EVAL_CONFIGURED_DATABASE/,
  );
  assert.equal(target.queries.length, 1);
});
test('refuses any populated application table, including an account without sessions', async () => {
  await assert.rejects(
    assertDisposableDatabase(
      pool('evaluation', [{ schemaname: 'public', tablename: 'tenants' }], true),
    ),
    /MEMORY_EVAL_DATABASE_NOT_EMPTY/,
  );
});
test('quotes database-provided identifiers and fails closed on unavailable checks', async () => {
  const target = pool('evaluation', [{ schemaname: 'odd"schema', tablename: 'odd"table' }]);
  await assertDisposableDatabase(target);
  assert.ok(target.queries.at(-1).includes('"odd""schema"."odd""table"'));
  await assert.rejects(
    assertDisposableDatabase(pool('evaluation'), {
      query: async () => {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
});
