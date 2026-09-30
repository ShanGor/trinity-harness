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
    let loopRoot: string | null = null;

    const handle = createTurnHandler({
      store,
      defaultWorkspaceRoot: '/ws',
      metas: {
        async get(id) {
          return id === sessionId ? meta : null;
        },
        async create() {},
        async listForIdentity() {
          return [];
        },
        async setPolicy() {},
        async setTitleIfEmpty() {},
        async close() {},
      },
      createLoop: (_sessionId, workspaceRoot) => {
        loopRoot = workspaceRoot;
        return new CoreAgentLoop({
          llm: new FakeLLM(
            () => toolCallThenFinish('c1', 'write_file', { path: 'x', content: 'y' }),
            () => textChunks('done'),
          ),
          model: 'fake/model',
          tools: new CoreToolRegistry(new FakeSandbox()),
          store,
          workspaceRoot,
        });
      },
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
      tenantId: 't1',
      promptSeq: 1,
      policy: parsePermissionPolicy('workspace-write'),
    };
    await handle(task);

    // Only transient deltas are live; durable events arrive through the log.
    expect(live.some((l) => l.event.type === 'tool/call')).toBe(false);
    expect(live.some((l) => l.event.type === 'text-delta')).toBe(true);
    expect(
      live.every((l) => l.event.type === 'text-delta' || l.event.type === 'reasoning-delta'),
    ).toBe(true);
    expect(live.every((l) => l.sessionId === sessionId)).toBe(true);

    // Audit records are tenant/user scoped from the session meta.
    const toolCallAudit = audit.filter((r) => r.action === 'tool/call');
    expect(toolCallAudit).toHaveLength(1);
    expect(toolCallAudit[0]).toMatchObject({ tenantId: 't1', userId: 'u1', target: 'write_file' });

    // The loop was sandboxed to the session workspace from the meta row.
    expect(loopRoot).toBe('/ws');

    // The durable log holds the full turn, actor-stamped via run options.
    const log = await store.load(sessionId);
    expect(log.filter((e) => e.type === 'tool/result')).toHaveLength(1);
    expect(log.at(-1)?.type).toBe('turn/end');
  });

  it('M4: forwards multimodal content blocks to the loop run options', async () => {
    const store = new MemorySessionStore();
    const sessionId = crypto.randomUUID();
    let seenContent: unknown = 'not-set';
    let seenRoot: string | null = null;
    const handle = createTurnHandler({
      store,
      defaultWorkspaceRoot: '/ws',
      metas: {
        async get() {
          return null;
        },
        async create() {},
        async listForIdentity() {
          return [];
        },
        async setPolicy() {},
        async setTitleIfEmpty() {},
        async close() {},
      },
      // The loop here is a probe: record the run options, then no-op.
      createLoop: (_sessionId, workspaceRoot) => {
        seenRoot = workspaceRoot;
        return {
          run: (_sid: string, _prompt: string, _sink: unknown, opts?: { content?: unknown }) => {
            seenContent = opts?.content ?? null;
            return Promise.resolve({ reason: 'completed', steps: 1 });
          },
        } as unknown as CoreAgentLoop;
      },
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
      tenantId: 't1',
      promptSeq: 1,
      policy: parsePermissionPolicy('workspace-write'),
    });
    expect(seenContent).toEqual(content);
    // No meta row ⇒ the deployment root is the fallback sandbox root.
    expect(seenRoot).toBe('/ws');
  });

  it('does not run a queued task after its session is closed', async () => {
    const sessionId = crypto.randomUUID();
    let loopCreated = false;
    const handle = createTurnHandler({
      store: new MemorySessionStore(),
      defaultWorkspaceRoot: '/ws',
      metas: {
        async get() {
          return {
            id: sessionId,
            tenantId: 't1',
            userId: 'u1',
            title: 'closed',
            workspaceUri: '/ws',
            createdAt: new Date().toISOString(),
            closedAt: new Date().toISOString(),
          };
        },
        async create() {},
        async listForIdentity() {
          return [];
        },
        async setPolicy() {},
        async setTitleIfEmpty() {},
        async close() {},
      },
      createLoop: () => {
        loopCreated = true;
        throw new Error('must not run');
      },
      live: { publish: () => {} },
      audit: { emit: () => {} },
    });
    await expect(
      handle({
        sessionId,
        prompt: 'hi',
        actor: 'u1',
        tenantId: 't1',
        promptSeq: 1,
        policy: parsePermissionPolicy('workspace-write'),
      }),
    ).rejects.toThrow('session closed');
    expect(loopCreated).toBe(false);
  });
});
