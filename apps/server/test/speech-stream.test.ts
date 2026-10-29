import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as createRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { MemorySessionStore } from '@trinity-harness/core';
import type { Identity, TenantQuota, UsagePort } from '@trinity-harness/contracts';
import type { FastifyInstance } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';

import { buildServer } from '../src/index.js';

const WS_DIR = mkdtempSync(path.join(tmpdir(), 'trinity-speech-stream-'));

const IDENTITY: Identity = {
  userId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  role: 'admin',
};

/** Upstream /ws fake: records what arrived, replies scripted JSON messages. */
interface FakeAsrWs {
  wss: WebSocketServer;
  /** http:// base URL the server config expects (it derives ws:// itself). */
  url: string;
  receivedBinary: Buffer[];
  receivedText: string[];
  lastSocket(): WebSocket | null;
}

async function fakeAsrWs(): Promise<FakeAsrWs> {
  const receivedBinary: Buffer[] = [];
  const receivedText: string[] = [];
  let lastSocket: WebSocket | null = null;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket) => {
    lastSocket = socket;
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data, isBinary) => {
      if (isBinary) receivedBinary.push(data as Buffer);
      else receivedText.push(String(data));
    });
  });
  const address = wss.address() as AddressInfo;
  return {
    wss,
    url: `http://127.0.0.1:${address.port}`,
    receivedBinary,
    receivedText,
    lastSocket: () => lastSocket,
  };
}

function usageWith(quota: TenantQuota): UsagePort {
  return {
    record: async () => undefined,
    usageSince: async () => 0,
    quotaOf: async () => quota,
  };
}

describe('streaming ASR proxy (docs/voice-call-design.md §8.1)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let upstream: FakeAsrWs;

  beforeAll(async () => {
    upstream = await fakeAsrWs();
    app = await buildServer({
      store: new MemorySessionStore(),
      workspaceRoot: WS_DIR,
      speech: { asrUrl: upstream.url, ttsUrl: upstream.url },
      usage: usageWith({}),
      auth: {
        tokens: { verify: async (t: string) => (t === 'good' ? IDENTITY : null) },
        hasher: { hash: async () => '', verify: async () => false },
      } as never,
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
    upstream.wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => {
      void upstream.wss.close(() => resolve());
    });
    rmSync(WS_DIR, { recursive: true, force: true });
  });

  it('relays config and binary PCM upstream and streams partial/final JSON back', async () => {
    const ws = new WebSocket(`${baseUrl}/api/speech/asr/stream?token=good`);
    ws.binaryType = 'arraybuffer';
    const received: string[] = [];
    ws.on('message', (d, isBinary) => {
      if (!isBinary) received.push(String(d));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open timeout')), 5000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', reject);
    });

    ws.send(JSON.stringify({ mode: '2pass', split_silence_ms: 700 }));
    ws.send(Buffer.alloc(3200, 1));
    ws.send(Buffer.alloc(3200, 2));

    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(upstream.receivedText).toContain(
      JSON.stringify({ mode: '2pass', split_silence_ms: 700 }),
    );
    expect(upstream.receivedBinary).toHaveLength(2);

    upstream
      .lastSocket()!
      .send(
        JSON.stringify({ mode: '2pass', wav_name: 'microphone', is_final: false, text: '你好' }),
      );
    upstream.lastSocket()!.send(
      JSON.stringify({
        mode: '2pass',
        wav_name: 'microphone',
        is_final: true,
        is_end: false,
        text: '你好世界',
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(received.some((m) => m.includes('"is_final":false'))).toBe(true);
    expect(received.some((m) => m.includes('"is_final":true'))).toBe(true);

    ws.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  });

  it('closes with 1013 when the tenant ASR stream concurrency limit is reached', async () => {
    const quotaApp = await buildServer({
      store: new MemorySessionStore(),
      workspaceRoot: WS_DIR,
      speech: { asrUrl: upstream.url, ttsUrl: upstream.url },
      usage: usageWith({ concurrentAsrStreams: 1 }),
      auth: {
        tokens: { verify: async (t: string) => (t === 'good' ? IDENTITY : null) },
        hasher: { hash: async () => '', verify: async () => false },
      } as never,
    });
    const quotaBase = await quotaApp.listen({ port: 0, host: '127.0.0.1' });

    const first = new WebSocket(`${quotaBase}/api/speech/asr/stream?token=good`);
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve);
      first.once('error', reject);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const second = new WebSocket(`${quotaBase}/api/speech/asr/stream?token=good`);
    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve) => {
      second.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(closeInfo.code).toBe(1013);
    expect(closeInfo.reason).toContain('concurrency');

    first.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    // The released slot admits a new connection.
    const third = new WebSocket(`${quotaBase}/api/speech/asr/stream?token=good`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('third open timeout')), 5000);
      third.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      third.once('error', reject);
    });
    third.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await quotaApp.close();
  });

  it('rejects unauthenticated upgrade requests when auth is configured', async () => {
    // Raw HTTP (not the ws client): a denied upgrade must answer 401 and
    // close the socket (connection: close) so drains are not blocked.
    const url = new URL(baseUrl);
    const result = await new Promise<{ status: number; connection: string | undefined }>(
      (resolve, reject) => {
        const req = createRequest(
          {
            host: url.hostname,
            port: url.port,
            path: '/api/speech/asr/stream',
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version': 13,
            },
          },
          (res) => {
            const { statusCode, headers } = res;
            res.resume();
            res.on('end', () =>
              resolve({ status: statusCode ?? 0, connection: headers.connection }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    expect(result.status).toBe(401);
    // The hook ends the raw socket after the 401 so a denied upgrade cannot
    // keep a half-open connection that blocks graceful drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const connections = (app.server as unknown as { _connections?: number })._connections ?? 0;
    expect(connections).toBe(0);
  });
});
