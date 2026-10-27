import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  BrowserGuestRelayPort,
  EnvironmentRecord,
  GuestEnvelope,
  GuestRelayPort,
} from '@trinity-harness/contracts';
import { FirecrackerGuestRelay } from '../src/guest-relay.js';
import { buildNodeAgent } from '../src/server.js';

it.each([
  { kind: 'read', content: 'guest', truncated: false },
  { kind: 'operationError', operation: 'read', code: 'FILE_NOT_FOUND', effect: 'none' },
] as const)(
  'performs Firecracker CONNECT and validates a generation-bound $kind response',
  async (value) => {
    // Keep UDS path below Linux's 108-byte sockaddr_un limit.
    const root = await mkdtemp(path.join(os.tmpdir(), 'tg-'));
    const generation = randomUUID();
    const directory = `${root}/jailer/firecracker/${generation}/root`;
    await mkdir(directory, { recursive: true });
    const environment: EnvironmentRecord = {
      id: randomUUID(),
      generation,
      tenantId: randomUUID(),
      userId: randomUUID(),
      nodeId: 'host-1',
      state: 'running',
      vcpus: 2,
      memoryMiB: 2048,
    };
    let envelope: GuestEnvelope = {
      requestId: randomUUID(),
      environmentId: environment.id,
      generation,
      sessionId: randomUUID(),
      workspace: 'personal',
      operation: { kind: 'read', path: 'file', maxBytes: 10 },
    };
    let handshake = '';
    let responseValue: unknown = value;
    const http = createHttpServer((request, reply) => {
      expect(request.url).toBe('/rpc');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(envelope);
        reply.setHeader('content-type', 'application/json');
        reply.end(
          JSON.stringify({
            requestId: envelope.requestId,
            generation,
            value: responseValue,
          }),
        );
      });
    });
    const server = createNetServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        handshake = chunk.toString();
        socket.write('OK 42\n');
        http.emit('connection', socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(`${directory}/vsock.sock`, resolve));
    try {
      expect(
        await new FirecrackerGuestRelay(root).call(
          environment,
          envelope,
          AbortSignal.timeout(3000),
        ),
      ).toEqual(value);
      expect(handshake).toBe('CONNECT 4050\n');
      envelope = { ...envelope, requestId: randomUUID(), operation: { kind: 'desktopFrame' } };
      responseValue = { kind: 'ok' };
      expect(
        await new FirecrackerGuestRelay(root).callBrowser(
          environment,
          envelope,
          AbortSignal.timeout(3000),
        ),
      ).toEqual({ kind: 'ok' });
      expect(handshake).toBe('CONNECT 4051\n');
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('revalidates PG owner/workspace/generation around guest dispatch and fails closed after revocation', async () => {
  const token = 't'.repeat(32),
    userId = randomUUID(),
    tenantId = randomUUID(),
    sessionId = randomUUID();
  const environment: EnvironmentRecord = {
    id: randomUUID(),
    generation: randomUUID(),
    tenantId,
    userId,
    nodeId: 'host-1',
    state: 'running',
    vcpus: 2,
    memoryMiB: 2048,
  };
  const request: GuestEnvelope = {
    requestId: randomUUID(),
    environmentId: environment.id,
    generation: environment.generation,
    sessionId,
    workspace: userId,
    operation: { kind: 'read', path: 'file', maxBytes: 100 },
  };
  const relay = {
    call: vi.fn<GuestRelayPort['call']>(async () => ({
      kind: 'read',
      content: 'private',
      truncated: false,
    })),
    callBrowser: vi.fn<BrowserGuestRelayPort['callBrowser']>(async () => ({ kind: 'ok' })),
  };
  const authorizeNode = vi.fn(async () => true);
  const meta = {
    id: sessionId,
    userId,
    tenantId,
    title: '',
    kind: 'work' as const,
    scope: 'personal' as const,
    workspaceUri: `/workspace/${userId}`,
    createdAt: '2026-01-01T00:00:00Z',
  };
  const user = {
    id: userId,
    tenantId,
    role: 'developer' as const,
    email: 'user@example.com',
    createdAt: meta.createdAt,
  };
  let releaseAssignment: ((value: boolean) => void) | undefined;
  const app = buildNodeAgent(
    { command: vi.fn() },
    {
      authorizeNode,
      runShared: async (_identity, action, signal) =>
        action(signal ?? new AbortController().signal),
    },
    'host-1',
    token,
    {
      relay,
      metas: {
        get: async () => {
          releaseAssignment?.(true);
          return meta;
        },
      },
      users: { findById: async () => user },
      workspaceRoot: '/workspace',
    },
  );
  const send = (payload = { environment, request }) =>
    app.inject({
      method: 'POST',
      url: '/guest',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  try {
    const desktop = {
      ...request,
      requestId: randomUUID(),
      operation: { kind: 'desktopFrame' as const },
    };
    expect((await send({ environment, request: desktop })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/guest-browser',
          headers: { authorization: `Bearer ${token}` },
          payload: { environment, request },
        })
      ).statusCode,
    ).toBe(400);
    expect(relay.callBrowser).not.toHaveBeenCalled();
    const browserResponse = await app.inject({
      method: 'POST',
      url: '/guest-browser',
      headers: { authorization: `Bearer ${token}` },
      payload: { environment, request: desktop },
    });
    expect(browserResponse.statusCode).toBe(200);
    expect(relay.callBrowser).toHaveBeenCalledTimes(1);
    relay.callBrowser.mockResolvedValueOnce({
      kind: 'desktopFrame',
      width: 1,
      height: 1,
      capturedAt: '2026-10-27T00:00:00.000Z',
      png: 'cHJpdmF0ZQ==',
    });
    authorizeNode.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const revokedDesktop = await app.inject({
      method: 'POST',
      url: '/guest-browser',
      headers: { authorization: `Bearer ${token}` },
      payload: { environment, request: desktop },
    });
    expect(revokedDesktop.statusCode).toBe(409);
    expect(revokedDesktop.body).not.toContain('cHJpdmF0ZQ==');
    expect(
      (await send({ environment, request: { ...request, workspace: 'another-user' } })).statusCode,
    ).toBe(409);
    expect(relay.call).not.toHaveBeenCalled();
    // The session read must start while the independent assignment read is pending.
    authorizeNode.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseAssignment = resolve;
        }),
    );
    expect((await send()).json()).toMatchObject({
      requestId: request.requestId,
      generation: environment.generation,
      value: { content: 'private' },
    });
    const failure = {
      kind: 'operationError',
      operation: 'read',
      code: 'FILE_NOT_FOUND',
      effect: 'none',
    } as const;
    relay.call.mockResolvedValueOnce(failure);
    expect((await send()).json()).toMatchObject({ value: failure });
    authorizeNode.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    relay.call.mockResolvedValueOnce(failure);
    const revoked = await send();
    expect(revoked.statusCode).toBe(409);
    expect(revoked.body).not.toContain('private');
    expect(revoked.body).not.toContain('FILE_NOT_FOUND');
  } finally {
    await app.close();
  }
});
