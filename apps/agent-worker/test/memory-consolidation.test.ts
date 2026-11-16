import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  createPool,
  PgMemoryStore,
  PgConversationIndex,
  PgSessionMetaStore,
  PgSessionStore,
  PgScheduleStore,
} from '@trinity-harness/db';
import {
  CoreAgentLoop,
  AiSdkGateway,
  CoreToolRegistry,
  PersonalContext,
  createPersonaTool,
  createRecallTool,
} from '@trinity-harness/core';
import {
  FakeLLM,
  textChunks,
  toolCallThenFinish,
} from '../../../packages/core/src/testing/fake-llm.js';
import { FakeSandbox } from '../../../packages/core/src/testing/fake-sandbox.js';

const url = process.env['DATABASE_URL'];
const admin = createPool(url ?? '', { connectionTimeoutMillis: 2000 });
let reachable = false;
if (url) {
  try {
    await admin.query('select 1');
    reachable = true;
  } catch {
    reachable = false;
  }
}
const schema = `consolidation_test_${randomUUID().replaceAll('-', '')}`;
const pool = createPool(url ?? '', {
  options: `-c search_path=${schema},public`,
  connectionTimeoutMillis: 2000,
});
let initialized = false;
beforeAll(async () => {
  if (!reachable) return;
  await admin.query(`create schema ${schema}`);
  initialized = true;
  for (const table of [
    'assistant_schedules',
    'schedule_occurrences',
    'users',
    'sessions',
    'session_events',
    'conversation_episodes',
    'episode_changes',
    'memory_events',
    'user_personas',
    'persona_events',
  ])
    await admin.query(`create table ${schema}.${table} (like public.${table} including all)`);
});
afterAll(async () => {
  await pool.end();
  if (initialized) await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});

describe.skipIf(!reachable)('durable memory consolidation', () => {
  it.each([
    'save',
    'excluded-after-read',
    'disabled-after-read',
    'removed-after-read',
    'no-read',
    ...(process.env['MEMORY_LIVE_ACCEPTANCE'] === '1' ? ['live' as const] : []),
  ] as const)(
    'checks transactional source fences: %s',
    async (scenario) => {
      const db = createDb(pool);
      const memory = new PgMemoryStore(db);
      const index = new PgConversationIndex(db);
      const metas = new PgSessionMetaStore(db);
      const store = new PgSessionStore(db);
      const schedules = new PgScheduleStore(db);
      const identity = { userId: randomUUID(), tenantId: randomUUID(), role: 'developer' as const };
      await pool.query(
        'insert into users(id,tenant_id,email,password_hash,role) values($1,$2,$3,$4,$5)',
        [
          identity.userId,
          identity.tenantId,
          `${identity.userId}@test.invalid`,
          'unused',
          'developer',
        ],
      );
      const original = { id: randomUUID() };
      await metas.create({
        id: original.id,
        ...identity,
        title: 'Original',
        kind: 'chat',
        sessionRole: 'side',
        scope: 'personal',
        workspaceUri: '/workspace',
      });
      const originalId = randomUUID();
      const originalAt = '2026-11-14T12:00:00.000Z';
      await store.append(original.id, [
        {
          type: 'message/user',
          eventId: originalId,
          at: originalAt,
          surfaceOp: 'append',
          content: [
            { kind: 'text', text: 'My name is Alex.' },
            { kind: 'image', uri: 'blob://attachment/missing', mimeType: 'image/png' },
          ],
        },
        {
          type: 'message/assistant',
          eventId: randomUUID(),
          at: originalAt,
          surfaceOp: 'append',
          phase: 'final',
          content: [{ kind: 'text', text: 'Hello.' }],
        },
        {
          type: 'turn/end',
          eventId: randomUUID(),
          at: originalAt,
          promptId: originalId,
          reason: 'completed',
        },
      ]);
      const template = { id: randomUUID() };
      await metas.create({
        id: template.id,
        ...identity,
        title: 'Memory review workspace',
        kind: 'work',
        sessionRole: 'task',
        scope: 'personal',
        workspaceUri: '/workspace',
        policy: 'workspace-write',
      });
      const schedule = await schedules.create(
        identity,
        {
          operationId: randomUUID(),
          title: 'Consolidation',
          request: 'Consolidate stable facts',
          sourceSessionId: template.id,
          timezone: 'UTC',
          consolidation: 'memory',
          timing: { kind: 'once', at: '2026-11-15T03:00:00.000Z' },
        },
        new Date('2026-11-14T23:00:00.000Z'),
      );
      await schedules.tick(new Date('2026-11-15T03:00:00.000Z'));
      const notice = (await schedules.inbox(identity)).find(
        (item) => item.scheduleId === schedule.id,
      )!;
      const sessionId = notice.sessionId!;
      const queued = (await store.load(sessionId)).find((event) => event.type === 'prompt/queued');
      if (queued?.type !== 'prompt/queued') throw new Error('Missing scheduled prompt');
      const appended = await store.append(sessionId, [
        {
          type: 'message/user',
          eventId: queued.promptId,
          at: queued.at,
          surfaceOp: 'append',
          content: queued.content,
          trigger: queued.trigger,
        },
      ]);
      const tools = new CoreToolRegistry(new FakeSandbox());
      tools.register(createRecallTool({ memory, index, metas, store }));
      const users = {
        findById: async () => ({
          id: identity.userId,
          tenantId: identity.tenantId,
          role: identity.role,
          email: 'test@example.invalid',
          createdAt: originalAt,
        }),
      };
      // Change policy/source after the tool's context check and before the transaction.
      const protectedMemory = {
        ...memory,
        snapshot: memory.snapshot.bind(memory),
        change: memory.change.bind(memory),
        savePersona: async (...args: Parameters<PgMemoryStore['savePersona']>) => {
          if (scenario === 'excluded-after-read')
            await index.revise(identity, originalId, { excluded: true });
          if (scenario === 'removed-after-read')
            await store.append(original.id, [
              {
                type: 'message/removed',
                eventId: randomUUID(),
                at: originalAt,
                promptId: originalId,
                role: 'user',
              },
            ]);
          if (scenario === 'disabled-after-read')
            await memory.savePersona(identity, {
              content: '',
              autoSaveEnabled: false,
              operationId: randomUUID(),
              expectedRevision: 0,
            });
          return memory.savePersona(...args);
        },
      };
      tools.register(createPersonaTool({ memory: protectedMemory, index, metas, store, users }));
      const save = () =>
        toolCallThenFinish('nightly-save', 'persona', {
          operation: 'update',
          expectedRevision: 0,
          sourceQuote: 'My name is Alex',
          sourceEpisodeId: originalId,
          sourceEventId: originalId,
          edits: [{ oldText: '', newText: '- My name is Alex' }],
        });
      const llm =
        scenario === 'no-read'
          ? new FakeLLM(save, () => textChunks('No source read'))
          : new FakeLLM(
              () => toolCallThenFinish('source-read', 'recall', { episodeId: originalId }),
              save,
              () => textChunks('Digest and memory result'),
            );
      const live = scenario === 'live';
      const gateway = new AiSdkGateway();
      const selectedModel = live ? process.env['MODEL']! : 'fake/model';
      const loop = new CoreAgentLoop({
        llm: live ? gateway : llm,
        model: selectedModel,
        maxSteps: 20,
        tools,
        store,
        workspaceRoot: '/workspace',
        personalContext: new PersonalContext(memory, index, store),
        sessionMetas: metas,
      });
      await loop.run(
        sessionId,
        'Consolidate',
        { emit: () => undefined },
        {
          actor: identity.userId,
          promptSeq: appended.from,
          contextGuard: async () => schedules.assertRunAuthorized(sessionId, identity.userId),
        },
      );
      const snapshot = await new PgMemoryStore(createDb(pool)).snapshot(identity);
      const readResult = (await store.load(sessionId)).find(
        (event) => event.type === 'tool/result' && event.callId === 'source-read',
      );
      if (!live && scenario !== 'no-read') {
        expect(readResult?.type === 'tool/result' ? readResult.value : undefined).toMatchObject({
          attachmentsOmitted: true,
        });
        expect(JSON.stringify(readResult)).not.toContain('blob://attachment/missing');
      }
      if (live) console.info('[memory-acceptance] consolidation finished');
      if (scenario === 'save' || live) {
        expect(snapshot.persona?.content).toContain('Alex');
        expect((await memory.personaHistory(identity)).revisions[0]?.source).toMatchObject({
          sessionId: original.id,
          eventId: originalId,
        });
        const fresh = { id: randomUUID() };
        await metas.create({
          id: fresh.id,
          ...identity,
          title: 'Fresh conversation',
          kind: 'chat',
          sessionRole: 'side',
          scope: 'personal',
          workspaceUri: '/workspace',
        });
        await store.append(fresh.id, [
          {
            type: 'session/created',
            eventId: randomUUID(),
            at: originalAt,
            kind: 'chat',
            sessionRole: 'side',
            workspaceUri: '/workspace',
          },
        ]);
        const next = new FakeLLM(() => textChunks('Your name is Alex.'));
        await new CoreAgentLoop({
          llm: live ? gateway : next,
          model: selectedModel,
          maxSteps: 12,
          tools,
          store,
          workspaceRoot: '/workspace',
          personalContext: new PersonalContext(memory, index, store),
          sessionMetas: metas,
        }).run(
          fresh.id,
          'What is my name?',
          { emit: () => undefined },
          { actor: identity.userId, contextGuard: async () => undefined },
        );
        if (live) {
          const final = (await store.load(fresh.id)).findLast(
            (event) => event.type === 'message/assistant' && event.phase === 'final',
          );
          expect(JSON.stringify(final)).toContain('Alex');
          console.info('[memory-acceptance] fresh-conversation recall passed');
          const foreground = new CoreAgentLoop({
            llm: gateway,
            model: selectedModel,
            maxSteps: 12,
            tools,
            store,
            workspaceRoot: '/workspace',
            personalContext: new PersonalContext(memory, index, store),
            sessionMetas: metas,
          });
          await foreground.run(
            fresh.id,
            'Correct my saved name: my name is Quinn now, not Alex.',
            { emit: () => undefined },
            { actor: identity.userId, contextGuard: async () => undefined },
          );
          expect((await memory.snapshot(identity)).persona?.content).toContain('Quinn');
          expect((await memory.snapshot(identity)).persona?.content).not.toContain('Alex');
          console.info('[memory-acceptance] correction passed');
          await foreground.run(
            fresh.id,
            'Please forget my name and remove it from saved personal memory.',
            { emit: () => undefined },
            { actor: identity.userId, contextGuard: async () => undefined },
          );
          expect(
            (await memory.snapshot(identity)).persona?.content,
            JSON.stringify(
              (await store.load(fresh.id))
                .filter(
                  (event) =>
                    event.type === 'tool/call' ||
                    event.type === 'tool/result' ||
                    event.type === 'turn/end',
                )
                .slice(-10),
            ),
          ).not.toContain('Quinn');
          console.info('[memory-acceptance] forgetting passed');
        } else expect(JSON.stringify(next.requests[0]?.messages)).toContain('- My name is Alex');
      } else expect(snapshot.persona?.content ?? '').toBe('');
      expect(
        (await index.history(identity, { limit: 50, timezone: 'UTC' })).episodes.some(
          (episode) => episode.sessionId === sessionId,
        ),
      ).toBe(false);
    },
    180_000,
  );
});
