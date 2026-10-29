import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MemorySessionStore } from '@trinity-harness/core';
import type {
  Identity,
  MediaGatewayEvent,
  MediaGatewayPort,
  MediaSession,
  MediaSessionRequest,
  MediaTokenPort,
  SessionMeta,
  SessionMetaStore,
  TenantQuota,
  UsagePort,
} from '@trinity-harness/contracts';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';

import { buildServer } from '../src/index.js';
import { RedisMediaTokens, type MediaTokenRedis } from '../src/media-token.js';

const WS_DIR = mkdtempSync(path.join(tmpdir(), 'trinity-media-'));

const IDENTITY: Identity = {
  userId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  role: 'admin',
};

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

class FakeMetaStore implements SessionMetaStore {
  private readonly metas = new Map<string, SessionMeta>();
  async create(meta: Omit<SessionMeta, 'createdAt'>): Promise<void> {
    this.metas.set(meta.id, { ...meta, createdAt: new Date().toISOString() });
  }
  async get(sessionId: string): Promise<SessionMeta | null> {
    return this.metas.get(sessionId) ?? null;
  }
  async listForIdentity(identity: Identity): Promise<SessionMeta[]> {
    return [...this.metas.values()].filter(
      (m) =>
        !m.closedAt &&
        m.tenantId === identity.tenantId &&
        (identity.role === 'admin' || m.userId === identity.userId),
    );
  }
  async setPolicy(sessionId: string, policy: string): Promise<void> {
    const meta = this.metas.get(sessionId);
    if (meta) this.metas.set(sessionId, { ...meta, policy });
  }
  async setTitleIfEmpty(sessionId: string, title: string): Promise<void> {
    const meta = this.metas.get(sessionId);
    if (meta && !meta.title) this.metas.set(sessionId, { ...meta, title });
  }
  async close(sessionId: string): Promise<void> {
    const meta = this.metas.get(sessionId);
    if (meta) this.metas.set(sessionId, { ...meta, closedAt: new Date().toISOString() });
  }
}

/** Minimal in-memory Redis for RedisMediaTokens (TTL semantics, no failures). */
class MemoryRedis implements MediaTokenRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  private readonly clock = Date.now();
  async set(key: string, value: string, _mode: 'EX', seconds: number): Promise<unknown> {
    this.store.set(key, { value, expiresAt: this.clock + seconds * 1000 });
    return 'OK';
  }
  async getdel(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    this.store.delete(key);
    if (!entry || entry.expiresAt <= this.clock) return null;
    return entry.value;
  }
  async del(key: string): Promise<unknown> {
    this.store.delete(key);
    return 1;
  }
}

class FakeMediaGateway implements MediaGatewayPort {
  readonly allocations: MediaSessionRequest[] = [];
  readonly offers: { mediaSessionId: string; sdp: string }[] = [];
  readonly ice: { mediaSessionId: string; candidate: Record<string, unknown> }[] = [];
  readonly closed: string[] = [];
  readonly speaks: { mediaSessionId: string; text: string }[] = [];
  readonly stops: string[] = [];
  private listeners = new Set<(event: MediaGatewayEvent) => void>();
  private counter = 0;
  /** When set, allocate() returns null once (upstream/capacity failure). */
  failNextAllocate = false;
  /** When set, speak() returns false once (TTS unavailable). */
  failNextSpeak = false;

  async allocate(request: MediaSessionRequest): Promise<MediaSession | null> {
    this.allocations.push(request);
    if (this.failNextAllocate) {
      this.failNextAllocate = false;
      return null;
    }
    this.counter += 1;
    return {
      mediaSessionId: `media-${this.counter}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  async answerOffer(mediaSessionId: string, sdp: string): Promise<{ sdp: string } | null> {
    this.offers.push({ mediaSessionId, sdp });
    return { sdp: `answer-for:${sdp}` };
  }

  async addIceCandidate(
    mediaSessionId: string,
    candidate: Record<string, unknown>,
  ): Promise<boolean> {
    this.ice.push({ mediaSessionId, candidate });
    return true;
  }

  async close(mediaSessionId: string): Promise<void> {
    this.closed.push(mediaSessionId);
  }

  async speak(mediaSessionId: string, text: string): Promise<boolean> {
    this.speaks.push({ mediaSessionId, text });
    if (this.failNextSpeak) {
      this.failNextSpeak = false;
      return false;
    }
    return true;
  }

  async stopSpeaking(mediaSessionId: string): Promise<void> {
    this.stops.push(mediaSessionId);
  }

  /** Test hook: simulate the gateway finishing a TTS downlink. */
  emitTtsEnded(mediaSessionId: string): void {
    this.emit({ type: 'tts_ended', mediaSessionId });
  }

  onEvent(listener: (event: MediaGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: MediaGatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function usageWith(quota: TenantQuota): UsagePort {
  return {
    record: async () => undefined,
    usageSince: async () => 0,
    quotaOf: async () => quota,
  };
}

/** A meta store pre-populated with the session owned by IDENTITY. */
async function ownedMetas(): Promise<FakeMetaStore> {
  const metas = new FakeMetaStore();
  await metas.create({
    id: SESSION_ID,
    tenantId: IDENTITY.tenantId,
    userId: IDENTITY.userId,
    title: 'Phone session',
    workspaceUri: null,
    kind: 'chat',
  });
  return metas;
}

interface SignalingClient {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  close(): Promise<void>;
}

function connect(baseUrl: string, loginToken: string): Promise<SignalingClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/api/media/signaling?token=${loginToken}`);
    const messages: Record<string, unknown>[] = [];
    const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
    ws.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>;
      messages.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]!.type === parsed.type) {
          waiters[i]!.resolve(parsed);
          waiters.splice(i, 1);
        }
      }
    });
    ws.on('open', () => {
      resolve({
        ws,
        messages,
        waitFor: (type, timeoutMs = 5000) =>
          new Promise<Record<string, unknown>>((res, rej) => {
            const existing = messages.find((m) => m.type === type);
            if (existing) return res(existing);
            const timer = setTimeout(
              () => rej(new Error(`timeout waiting for ${type}`)),
              timeoutMs,
            );
            waiters.push({
              type,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          }),
        send: (message) => ws.send(JSON.stringify(message)),
        close: () =>
          new Promise<void>((res) => {
            if (ws.readyState === WebSocket.CLOSED) return res();
            ws.once('close', () => res());
            ws.close();
          }),
      });
    });
    ws.on('error', reject);
  });
}

async function issueToken(baseUrl: string, loginToken: string, sessionId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/media/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginToken}` },
    body: JSON.stringify({ sessionId }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

describe('WebRTC media signaling (docs/webrtc-media-design.md §3–§5)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let gateway: FakeMediaGateway;
  let mediaTokens: MediaTokenPort;

  beforeAll(async () => {
    gateway = new FakeMediaGateway();
    mediaTokens = new RedisMediaTokens(new MemoryRedis(), 600);
    const metas = new FakeMetaStore();
    await metas.create({
      id: SESSION_ID,
      tenantId: IDENTITY.tenantId,
      userId: IDENTITY.userId,
      title: 'Phone session',
      workspaceUri: null,
      kind: 'chat',
    });
    app = await buildServer({
      store: new MemorySessionStore(),
      workspaceRoot: WS_DIR,
      usage: usageWith({}),
      mediaTokens,
      mediaGateway: gateway,
      auth: {
        tokens: {
          verify: async (t: string) => (t === 'good' ? IDENTITY : null),
          issue: async () => 'good',
        },
        metas,
        users: {} as never,
        hasher: {} as never,
      },
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
    rmSync(WS_DIR, { recursive: true, force: true });
  });

  it('issues one-time media tokens only for owned, live sessions', async () => {
    const token = await issueToken(baseUrl, 'good', SESSION_ID);
    expect(token).toBeTruthy();
    // A second issuance is independent; consumption is what enforces one-time use.
    const other = await issueToken(baseUrl, 'good', SESSION_ID);
    expect(other).not.toBe(token);

    const denied = await fetch(`${baseUrl}/api/media/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({ sessionId: '99999999-9999-4999-8999-999999999999' }),
    });
    expect(denied.status).toBe(404);

    const anon = await fetch(`${baseUrl}/api/media/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(anon.status).toBe(401);
  });

  it('runs the full signaling sequence: hello → offer → ICE → ASR events → bye', async () => {
    const token = await issueToken(baseUrl, 'good', SESSION_ID);
    const client = await connect(baseUrl, 'good');

    client.send({ type: 'media.hello', token, sessionId: SESSION_ID });
    const ready = (await client.waitFor('media.ready')) as { mediaSessionId: string };
    expect(ready.mediaSessionId).toBe('media-1');
    expect(gateway.allocations).toHaveLength(1);

    client.send({ type: 'media.offer', sdp: 'offer-sdp' });
    const answer = (await client.waitFor('media.answer')) as { sdp: string };
    expect(answer.sdp).toBe('answer-for:offer-sdp');
    expect(gateway.offers).toEqual([{ mediaSessionId: 'media-1', sdp: 'offer-sdp' }]);

    client.send({ type: 'media.ice', candidate: { candidate: 'cand', sdpMLineIndex: 0 } });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(gateway.ice).toHaveLength(1);

    // Gateway ASR results are relayed without the server-side session id.
    gateway.emit({ type: 'asr_partial', mediaSessionId: 'media-1', text: '你好' });
    const partial = await client.waitFor('media.asr_partial');
    expect(partial).toMatchObject({ type: 'media.asr_partial', text: '你好' });
    expect(partial).not.toHaveProperty('mediaSessionId');
    gateway.emit({ type: 'asr_final', mediaSessionId: 'media-1', text: '你好世界' });
    await client.waitFor('media.asr_final');

    // Events for other sessions are not relayed to this socket.
    gateway.emit({ type: 'asr_partial', mediaSessionId: 'media-2', text: '别的会话' });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(client.messages.filter((m) => m.type === 'media.asr_partial')).toHaveLength(1);

    client.send({ type: 'media.bye' });
    await client.close();
    expect(gateway.closed).toContain('media-1');
  });

  it('rejects reused tokens, session mismatches and pre-hello offers', async () => {
    const token = await issueToken(baseUrl, 'good', SESSION_ID);
    const first = await connect(baseUrl, 'good');
    first.send({ type: 'media.hello', token, sessionId: SESSION_ID });
    await first.waitFor('media.ready');
    // Reuse on a second socket must fail even though the first is still open.
    const second = await connect(baseUrl, 'good');
    second.send({ type: 'media.hello', token, sessionId: SESSION_ID });
    const err = (await second.waitFor('media.error')) as { code: string };
    expect(err.code).toBe('token_expired');
    await second.close();

    const mismatched = await issueToken(baseUrl, 'good', SESSION_ID);
    const third = await connect(baseUrl, 'good');
    third.send({ type: 'media.hello', token: mismatched, sessionId: 'some-other-session' });
    const err2 = (await third.waitFor('media.error')) as { code: string };
    expect(err2.code).toBe('invalid_session');
    await third.close();

    const fourth = await connect(baseUrl, 'good');
    fourth.send({ type: 'media.offer', sdp: 'early' });
    const err3 = (await fourth.waitFor('media.error')) as { code: string };
    expect(err3.code).toBe('not_bound');
    await fourth.close();

    await first.close();
  });

  it('rejects malformed messages with bad_message', async () => {
    const client = await connect(baseUrl, 'good');
    client.ws.send('not json');
    const err = (await client.waitFor('media.error')) as { code: string };
    expect(err.code).toBe('bad_message');
    await client.close();
  });

  it('relays TTS downlinks: speak → tts_ended, stop_speaking, and tts_unavailable', async () => {
    const token = await issueToken(baseUrl, 'good', SESSION_ID);
    const client = await connect(baseUrl, 'good');
    client.send({ type: 'media.hello', token, sessionId: SESSION_ID });
    const ready = (await client.waitFor('media.ready')) as { mediaSessionId: string };

    client.send({ type: 'media.speak', text: '第一句话' });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(gateway.speaks).toEqual([{ mediaSessionId: ready.mediaSessionId, text: '第一句话' }]);

    gateway.emitTtsEnded(ready.mediaSessionId);
    await client.waitFor('media.tts_ended');

    client.send({ type: 'media.stop_speaking' });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(gateway.stops).toContain(ready.mediaSessionId);

    gateway.failNextSpeak = true;
    client.send({ type: 'media.speak', text: '第二句话' });
    const err = (await client.waitFor('media.error')) as { code: string };
    expect(err.code).toBe('tts_unavailable');
    await client.close();
  });

  it('answers 501 when the media plane is not configured', async () => {
    const bare = await buildServer({
      store: new MemorySessionStore(),
      workspaceRoot: WS_DIR,
    });
    const bareUrl = await bare.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${bareUrl}/api/media/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(response.status).toBe(501);
    await bare.close();
  });

  describe('quota and gateway capacity', () => {
    it('denies concurrent media sessions over the tenant limit and re-admits after release', async () => {
      const quotaApp = await buildServer({
        store: new MemorySessionStore(),
        workspaceRoot: WS_DIR,
        usage: usageWith({ concurrentMediaSessions: 1 }),
        mediaTokens,
        mediaGateway: gateway,
        auth: {
          tokens: {
            verify: async (t: string) => (t === 'good' ? IDENTITY : null),
            issue: async () => 'good',
          },
          metas: await ownedMetas(),
          users: {} as never,
          hasher: {} as never,
        },
      });
      // Same session ownership as the main app: recreate the meta.
      const quotaUrl = await quotaApp.listen({ port: 0, host: '127.0.0.1' });

      const tokenA = await issueToken(quotaUrl, 'good', SESSION_ID);
      const a = await connect(quotaUrl, 'good');
      a.send({ type: 'media.hello', token: tokenA, sessionId: SESSION_ID });
      await a.waitFor('media.ready');

      const tokenB = await issueToken(quotaUrl, 'good', SESSION_ID);
      const b = await connect(quotaUrl, 'good');
      b.send({ type: 'media.hello', token: tokenB, sessionId: SESSION_ID });
      const err = (await b.waitFor('media.error')) as { code: string };
      expect(err.code).toBe('capacity');
      await b.close();

      // Hanging up A releases the slot for C.
      await a.close();
      const tokenC = await issueToken(quotaUrl, 'good', SESSION_ID);
      const c = await connect(quotaUrl, 'good');
      c.send({ type: 'media.hello', token: tokenC, sessionId: SESSION_ID });
      await c.waitFor('media.ready');
      await c.close();
      await quotaApp.close();
    });

    it('fails closed when the gateway cannot allocate', async () => {
      gateway.failNextAllocate = true;
      const token = await issueToken(baseUrl, 'good', SESSION_ID);
      const client = await connect(baseUrl, 'good');
      client.send({ type: 'media.hello', token, sessionId: SESSION_ID });
      const err = (await client.waitFor('media.error')) as { code: string };
      expect(err.code).toBe('gateway_unavailable');
      await client.close();
    });
  });
});
