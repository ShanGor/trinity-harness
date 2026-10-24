import 'dotenv/config';
import Fastify from 'fastify';
import { z } from 'zod';
import { createDb, createPool, PgScheduleStore } from '@trinity-harness/db';
import { runControlWorker } from './runner.js';

async function main(): Promise<void> {
  const env = z
    .object({
      DATABASE_URL: z.string().min(1),
      SCHEDULING_ENABLED: z.literal('true'),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().positive().default(3020),
    })
    .parse(process.env);
  const pool = createPool(env.DATABASE_URL, {
    connectionTimeoutMillis: 5000,
    query_timeout: 15_000,
  });
  const controller = new AbortController();
  const app = Fastify({ logger: false });
  let lastSuccess = 0;
  const store = new PgScheduleStore(createDb(pool));
  app.get('/health', async (_req, reply) =>
    lastSuccess && Date.now() - lastSuccess < 60_000
      ? { ok: true }
      : reply.code(503).send({ ok: false }),
  );
  const running = runControlWorker(
    {
      tick: async (at, signal) => {
        await store.tick(at, signal);
        lastSuccess = Date.now();
      },
    },
    controller.signal,
    () => new Date(),
    () => console.error('[control-worker] reconciliation unavailable'),
  );
  const shutdown = (): void => controller.abort();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    await running;
  } finally {
    controller.abort();
    try {
      await running;
      await app.close();
    } finally {
      await pool.end();
      process.removeListener('SIGTERM', shutdown);
      process.removeListener('SIGINT', shutdown);
    }
  }
}
void main().catch(() => {
  console.error('Control worker startup failed');
  process.exitCode = 1;
});
