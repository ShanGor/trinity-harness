import { describe, expect, it } from 'vitest';
import { MemorySessionStore } from '@trinity-harness/core';
import type { ApprovalReply } from '@trinity-harness/contracts';
import { buildServer } from '../src/server.js';

describe('conversation command approvals', () => {
  it('persists matching grants before notifying the worker and rejects forged or stale requests', async () => {
    const store = new MemorySessionStore();
    const replies: ApprovalReply[] = [];
    const app = await buildServer({
      store,
      workspaceRoot: '/tmp',
      approvals: {
        listen: () => ({
          onRequest: () => undefined,
          reply: (reply) => {
            expect(store).toBeDefined();
            replies.push(reply);
          },
          dispose: () => undefined,
          [Symbol.dispose](): void {
            this.dispose();
          },
        }),
      },
    });
    try {
      const id = (await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).json()
        .sessionId as string;
      const other = (await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).json()
        .sessionId as string;
      const approvalId = crypto.randomUUID();
      const meta = { eventId: crypto.randomUUID(), at: '2026-01-01T00:00:00.000Z' };
      await store.append(id, [
        {
          ...meta,
          type: 'tool/call',
          callId: 'c',
          name: 'bash',
          args: { command: 'custom-cli inspect' },
        },
        {
          ...meta,
          eventId: crypto.randomUUID(),
          type: 'approval/requested',
          approvalId,
          toolCallId: 'c',
          toolName: 'bash',
          argsPreview: 'truncated',
        },
      ]);
      const respond = (sessionId: string, prefix: string[]) =>
        app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/approvals/${approvalId}/respond`,
          payload: { outcome: 'allowed', commandPrefix: prefix },
        });
      expect((await respond(other, ['custom-cli'])).statusCode).toBe(409);
      expect((await respond(id, ['curl'])).statusCode).toBe(400);
      expect((await respond(id, ['custom-cli;'])).statusCode).toBe(400);
      expect((await respond(id, ['custom-cli'])).statusCode).toBe(200);
      expect((await store.load(id)).at(-1)).toMatchObject({
        type: 'approval/command_granted',
        prefix: ['custom-cli'],
        approvalId,
      });
      expect(replies).toHaveLength(1);
      await store.append(id, [
        {
          ...meta,
          eventId: crypto.randomUUID(),
          type: 'approval/resolved',
          approvalId,
          outcome: 'allowed',
          decidedBy: 'anonymous',
        },
      ]);
      expect((await respond(id, ['custom-cli'])).statusCode).toBe(409);
      expect(replies).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
