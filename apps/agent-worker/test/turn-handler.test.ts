import { describe, expect, it } from 'vitest';

import type {
  AuditRecord,
  ContentBlock,
  LoopEvent,
  SessionMeta,
  TurnTask,
} from '@trinity-harness/contracts';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import { CoreAgentLoop, CoreToolRegistry, MemorySessionStore } from '@trinity-harness/core';
import {
  FakeLLM,
  FakeSandbox,
  textChunks,
  toolCallThenFinish,
} from '@trinity-harness/core/testing';

import { createTurnHandler } from '../src/index.js';

/** Turn handler unit test: live deltas fan out, tool invocations are audited. */
describe('createTurnHandler', () => {
  it('runs the loop, publishes live events and audits tool calls', async () => {
    const store = new MemorySessionStore();
    const sessionId = crypto.randomUUID();
    const meta: SessionMeta = {
      id: sessionId,
      tenantId: 't1',
      userId: 'u1',
      title: '',
      workspaceUri: '/ws',
      createdAt: new Date().toISOString(),
    };
    const live: { sessionId: string; event: LoopEvent }[] = [];
    const audit: AuditRecord[] = [];

    const handle = createTurnHandler({
      store,
      metas: {
        async get(id) {
          return id === sessionId ? meta : null;
        },
        async create() {},
        async listForIdentity() {
          return [];
        },
        async setPolicy() {},
      },
      createLoop: () =>
        new CoreAgentLoop({
          llm: new FakeLLM(
            () => toolCallThenFinish('c1', 'write_file', { path: 'x', content: 'y' }),
            () => textChunks('done'),
          ),
          model: 'fake/model',
          tools: new CoreToolRegistry(new FakeSandbox()),
          store,
          workspaceRoot: '/ws',
        }),
      live: {
        publish: (sid, event) => {
          live.push({ sessionId: sid, event });
        },
      },
      audit: {
        emit: (record) => {
          audit.push(record);
        },
      },
    });

    const task: TurnTask = {
      sessionId,
      prompt: 'hi',
      actor: 'u1',
      promptSeq: 1,
      policy: parsePermissionPolicy('workspace-write'),
    };
    await handle(task);

    // Live stream carried deltas + tool lifecycle; committed state is in the log.
    expect(live.some((l) => l.event.type === 'tool/call')).toBe(true);
    expect(live.some((l) => l.event.type === 'text-delta')).toBe(true);
    expect(live.every((l) => l.sessionId === sessionId)).toBe(true);

    // Audit records are tenant/user scoped from the session meta.
    const toolCallAudit = audit.filter((r) => r.action === 'tool/call');
    expect(toolCallAudit).toHaveLength(1);
    expect(toolCallAudit[0]).toMatchObject({ tenantId: 't1', userId: 'u1', target: 'write_file' });

    // The durable log holds the full turn, actor-stamped via run options.
    const log = await store.load(sessionId);
    expect(log.filter((e) => e.type === 'tool/result')).toHaveLength(1);
    expect(log.at(-1)?.type).toBe('turn/end');
  });

  it('M4: forwards multimodal content blocks to the loop run options', async () => {
    const store = new MemorySessionStore();
    const sessionId = crypto.randomUUID();
    let seenContent: unknown = 'not-set';
    const handle = createTurnHandler({
      store,
      metas: {
        async get() {
          return null;
        },
        async create() {},
        async listForIdentity() {
          return [];
        },
        async setPolicy() {},
      },
      // The loop here is a probe: record the run options, then no-op.
      createLoop: () =>
        ({
          run: (_sid: string, _prompt: string, _sink: unknown, opts?: { content?: unknown }) => {
            seenContent = opts?.content ?? null;
            return Promise.resolve({ reason: 'completed', steps: 1 });
          },
        }) as unknown as CoreAgentLoop,
      live: { publish: () => {} },
      audit: { emit: () => {} },
    });

    const content: ContentBlock[] = [
      { kind: 'text', text: 'look at this' },
      { kind: 'image', uri: 'blob://k', mimeType: 'image/png' },
    ];
    await handle({
      sessionId,
      prompt: 'look at this',
      content,
      actor: 'u1',
      promptSeq: 1,
      policy: parsePermissionPolicy('workspace-write'),
    });
    expect(seenContent).toEqual(content);
  });
});
