import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AiSdkEmbeddingGateway,
  ProviderEndpointPolicy,
  infrastructureCredentials,
  llmInfrastructureEnvShape,
} from '@trinity-harness/core';
import {
  createPool,
  createDb,
  createTenant,
  PgUserStore,
  PgLlmConfigurationStore,
  PgSessionStore,
  PgSessionMetaStore,
  PgUsageStore,
  PgConversationIndex,
  PgEpisodeVectorStore,
} from '@trinity-harness/db';
import { SemanticRecall, reconcileEmbeddings } from '@trinity-harness/memory';
import {
  evaluationEpisodes,
  evaluationQuestions,
} from '../../../packages/memory/test/eval/fixtures.js';
import { z } from 'zod';

const enabled = process.env['TRINITY_RUN_MEMORY_EVAL'] === '1';
const url = process.env['TRINITY_MEMORY_TEST_DATABASE_URL'];
const pool = createPool(url ?? 'postgresql://invalid/unused', { connectionTimeoutMillis: 2000 });
afterAll(async () => pool.end());
describe.skipIf(!enabled)(
  'opt-in real embedding retrieval gate (fresh disposable database only)',
  () => {
    it('compares lexical and hybrid on identical owned synthetic history and records no raw content', async () => {
      if (!url || !process.env['MEMORY_EMBEDDING_MODEL'])
        throw new Error(
          'Configure a fresh disposable TRINITY_MEMORY_TEST_DATABASE_URL and MEMORY_EMBEDDING_MODEL',
        );
      const db = createDb(pool);
      const rows = await pool.query('select count(*)::int as count from sessions');
      if (rows.rows[0]?.count !== 0)
        throw new Error('Real memory evaluation requires an empty disposable database');
      const tenant = await createTenant(db, 'memory-evaluation');
      const users = new PgUserStore(db, { hash: async () => 'unused', verify: async () => false });
      const user = await users.createUser({
        tenantId: tenant.id,
        email: `memory-${randomUUID()}@example.test`,
        passwordHash: 'unused-evaluation-account',
        role: 'member',
      });
      const owner = { tenantId: tenant.id, userId: user.id, role: user.role };
      const metas = new PgSessionMetaStore(db);
      const store = new PgSessionStore(db);
      const sessionId = randomUUID();
      await metas.create({
        id: sessionId,
        ...owner,
        kind: 'chat',
        sessionRole: 'side',
        workspaceUri: null,
        title: 'Synthetic memory evaluation',
      });
      const ids: string[] = [];
      for (const episode of evaluationEpisodes) {
        const promptId = randomUUID();
        ids.push(promptId);
        await store.append(sessionId, [
          {
            type: 'message/user',
            eventId: promptId,
            at: episode.at,
            surfaceOp: 'append',
            content: [{ kind: 'text', text: episode.request }],
          },
          {
            type: 'message/assistant',
            eventId: randomUUID(),
            at: episode.at,
            surfaceOp: 'append',
            phase: 'final',
            content: [{ kind: 'text', text: episode.outcome }],
          },
          {
            type: 'turn/end',
            eventId: randomUUID(),
            at: episode.at,
            reason: 'completed',
            promptId,
          },
        ]);
      }
      const env = z.object(llmInfrastructureEnvShape).parse(process.env);
      const embedding = new AiSdkEmbeddingGateway(process.env['MEMORY_EMBEDDING_MODEL']!, {
        configuration: new PgLlmConfigurationStore(db),
        credentials: infrastructureCredentials(env.LLM_CREDENTIAL_KEY_ID, env.LLM_CREDENTIAL_KEYS),
        policy: new ProviderEndpointPolicy(env.LLM_PROVIDER_DESTINATIONS),
        store,
        metas,
        users,
        usage: new PgUsageStore(db),
        pricing: {},
      });
      const index = new PgConversationIndex(db);
      const vectors = new PgEpisodeVectorStore(db);
      expect(await reconcileEmbeddings(vectors, embedding, AbortSignal.timeout(120_000))).toEqual({
        completed: 5,
        failed: 0,
      });
      const hybrid = new SemanticRecall(index, vectors, embedding);
      let lexicalCorrect = 0;
      let hybridCorrect = 0;
      for (const q of evaluationQuestions) {
        const query = { query: q.query, limit: 10, recallOnly: true, timezone: 'UTC' };
        const lexical = await index.history(owner, query);
        const result = await hybrid.searchEpisodes(owner, query, {
          sessionId,
          promptId: ids.at(-1)!,
          signal: AbortSignal.timeout(30_000),
        });
        expect(result.recallMode).toBe('hybrid');
        if (
          q.expected === null
            ? !lexical.episodes.length
            : lexical.episodes[0]?.promptId === ids[q.expected]
        )
          lexicalCorrect++;
        if (
          q.expected === null
            ? !result.episodes.length
            : result.episodes[0]?.promptId === ids[q.expected]
        )
          hybridCorrect++;
      }
      console.info(
        JSON.stringify({
          suite: 'memory-retrieval-v1',
          questions: evaluationQuestions.length,
          lexicalCorrect,
          hybridCorrect,
          provider: 'configured',
          syntheticOnly: true,
        }),
      );
      expect(hybridCorrect).toBeGreaterThanOrEqual(lexicalCorrect);
    }, 240_000);
  },
);
