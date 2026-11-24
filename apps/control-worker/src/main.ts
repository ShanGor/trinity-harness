import { memoryEvolutionEnvShape } from '@trinity-harness/contracts';
import { reconcileEmbeddings } from '@trinity-harness/memory';
import {
  AiSdkEmbeddingGateway,
  ProviderEndpointPolicy,
  infrastructureCredentials,
  loadModelPricingConfig,
} from '@trinity-harness/core';
import {
  PgEpisodeVectorStore,
  PgLlmConfigurationStore,
  PgSessionStore,
  PgSessionMetaStore,
  PgUsageStore,
  PgUserStore,
} from '@trinity-harness/db';
import {
  llmInfrastructureEnvShape,
  ScryptPasswordHasher,
  createCalendarPush,
} from '@trinity-harness/core';
import { PgCalendarStore } from '@trinity-harness/db';
import 'dotenv/config';
import Fastify from 'fastify';
import { z } from 'zod';
import { createDb, createPool, PgScheduleStore } from '@trinity-harness/db';
import { runControlWorker } from './runner.js';

async function main(): Promise<void> {
  const env = z
    .object({
      ...memoryEvolutionEnvShape,
      ...llmInfrastructureEnvShape,
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
  const db = createDb(pool);
  const store = new PgScheduleStore(db);
  const vectors =
    env.MEMORY_EVOLUTION_ENABLED && env.MEMORY_EMBEDDING_MODEL
      ? new PgEpisodeVectorStore(db)
      : undefined;
  const embedding = vectors
    ? new AiSdkEmbeddingGateway(env.MEMORY_EMBEDDING_MODEL!, {
        configuration: new PgLlmConfigurationStore(db),
        credentials: infrastructureCredentials(env.LLM_CREDENTIAL_KEY_ID, env.LLM_CREDENTIAL_KEYS),
        policy: new ProviderEndpointPolicy(env.LLM_PROVIDER_DESTINATIONS),
        store: new PgSessionStore(db),
        metas: new PgSessionMetaStore(db),
        usage: new PgUsageStore(db),
        users: new PgUserStore(db, new ScryptPasswordHasher()),
        pricing: loadModelPricingConfig(new URL('../../../config/models.yaml', import.meta.url)),
      })
    : undefined;
  const calendar = new PgCalendarStore(db, createCalendarPush(process.env));
  app.get('/health', async (_req, reply) =>
    lastSuccess && Date.now() - lastSuccess < 60_000
      ? { ok: true }
      : reply.code(503).send({ ok: false }),
  );
  const running = runControlWorker(
    {
      tick: async (at, signal) => {
        await store.tick(at, signal);
        await calendar.tick(at, signal);
        lastSuccess = Date.now();
      },
    },
    controller.signal,
    () => new Date(),
    () => console.error('[control-worker] reconciliation unavailable'),
  );
  // Provider latency must not delay schedule/calendar ticks or their readiness signal.
  const embeddingRunning =
    vectors && embedding
      ? runControlWorker(
          {
            tick: async (_at, signal) => {
              const result = await reconcileEmbeddings(
                vectors,
                embedding,
                signal ?? controller.signal,
              );
              if (result.failed) console.error('[control-worker] memory embedding unavailable');
            },
          },
          controller.signal,
          () => new Date(),
          () => console.error('[control-worker] memory embedding unavailable'),
        )
      : Promise.resolve();
  const shutdown = (): void => controller.abort();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    await Promise.all([running, embeddingRunning]);
  } finally {
    controller.abort();
    try {
      await Promise.allSettled([running, embeddingRunning]);
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
