import { expect, it } from 'vitest';
import { MemorySessionStore } from '@trinity-harness/core';
import { newId } from '@trinity-harness/shared';
import { buildServer, logEventToServerEvent } from '../src/server.js';

it('admits REST and ACP supplements against the same active task without creating turns', async () => {
  const store = new MemorySessionStore();
  const app = await buildServer({ store, workspaceRoot: '/ws' });
  try {
    const sessionId = newId();
    const promptId = newId();
    const fields = { at: new Date().toISOString() };
    await store.append(sessionId, [
      {
        ...fields,
        eventId: promptId,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Compare A and B' }],
      },
      { ...fields, eventId: newId(), type: 'turn/start', promptId },
    ]);
    const inputId = newId();
    const payload = { text: 'Use C instead of B', steering: { inputId, promptId } };
    const url = `/api/sessions/${sessionId}/messages`;
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(202);
    expect(
      (await app.inject({ method: 'POST', url, payload: { ...payload, text: 'different' } }))
        .statusCode,
    ).toBe(409);
    const rpc = await app.inject({
      method: 'POST',
      url: '/acp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'Also explain compatibility' }],
          _meta: { 'trinity.steering': { inputId: newId(), promptId } },
        },
      },
    });
    expect(rpc.json().result._meta['trinity.steeringAccepted']).toBeTruthy();
    const events = await store.load(sessionId);
    expect(events.filter((event) => event.type === 'message/user')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'steering/accepted')).toHaveLength(2);
    expect(logEventToServerEvent(sessionId, events[2]!)).toMatchObject({
      type: 'session/steering',
      state: 'waiting',
      text: payload.text,
    });
    await store.append(sessionId, [
      { ...fields, eventId: newId(), type: 'turn/end', promptId, reason: 'aborted' },
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { text: 'late', steering: { inputId: newId(), promptId } },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { text: 'invalid', steering: { inputId: 'bad', promptId } },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
