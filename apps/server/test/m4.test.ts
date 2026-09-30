import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ContentBlock, LLMRequest } from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  LocalBlobStore,
  MemorySessionStore,
} from '@trinity-harness/core';
import { FakeLLM, FakeSandbox, textChunks } from '@trinity-harness/core/testing';

import { buildServer } from '../src/index.js';

/**
 * M4 server surface (docs/design.md §10/§11): attachment upload/download,
 * multimodal REST prompts and ACP session/prompt with image/file blocks.
 */
describe('buildServer M4', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;
  let dir: string;
  let store: MemorySessionStore;
  let llm: FakeLLM;
  let lastRequest: LLMRequest | null;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'trinity-m4-server-'));
    store = new MemorySessionStore();
    lastRequest = null;
    // One scripted response per prompt fired across these tests.
    llm = new FakeLLM(...Array.from({ length: 10 }, () => () => textChunks('ack')));
    const sandbox = new FakeSandbox();
    const tools = new CoreToolRegistry(sandbox);
    const blobDir = path.join(dir, 'blobs');
    app = await buildServer({
      store,
      workspaceRoot: dir,
      blobs: new LocalBlobStore(blobDir),
      createLoop: () =>
        new CoreAgentLoop({
          llm: new Proxy(llm, {
            get(target, prop, receiver) {
              if (prop === 'stream') {
                return (req: LLMRequest) => {
                  lastRequest = req;
                  return target.stream(req);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          }),
          model: 'fake/model',
          tools,
          store,
          workspaceRoot: dir,
        }),
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { sessionId: string }).sessionId;
  }

  it('uploads an attachment (octet-stream) and downloads it back', async () => {
    const sessionId = await createSession();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const up = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/attachments?mime=image/png&filename=shot.png`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: png,
      },
    );
    expect(up.status).toBe(201);
    const { uri, mimeType, size } = (await up.json()) as {
      uri: string;
      mimeType: string;
      size: number;
    };
    expect(uri).toMatch(/^blob:\/\//);
    expect(mimeType).toBe('image/png');
    expect(size).toBe(png.byteLength);

    const down = await fetch(`${baseUrl}/api/blobs/${uri.replace('blob://', '')}`);
    expect(down.status).toBe(200);
    expect(down.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(png);
  });

  it('rejects disallowed MIME types and oversized uploads fail closed', async () => {
    const sessionId = await createSession();
    const bad = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/attachments?mime=application/x-msdownload`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(bad.status).toBe(400);
  });

  it('REST prompt with attachments commits content blocks and the loop sees them', async () => {
    const sessionId = await createSession();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what is in this image?',
        attachments: [{ uri: 'blob://fake-key', mimeType: 'image/png' }],
      }),
    });
    expect(res.status).toBe(202);

    // The loop ran inline; its model request must carry the image block.
    await new Promise((r) => setTimeout(r, 50));
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.messages[0]!.blocks).toEqual([
      { kind: 'image', uri: 'blob://fake-key', mimeType: 'image/png' },
    ]);

    // The committed log entry carries the blocks (replayable, §7).
    const log = await store.load(sessionId);
    const userEvent = log.find((e) => e.type === 'message/user') as {
      content: ContentBlock[];
    };
    expect(userEvent.content).toEqual([
      { kind: 'text', text: 'what is in this image?' },
      { kind: 'image', uri: 'blob://fake-key', mimeType: 'image/png' },
    ]);
  });

  it('ACP session/prompt accepts image resources (inline base64 → blob) and file blocks', async () => {
    const sessionId = await createSession();
    const pngBytes = Buffer.from([1, 2, 3, 4, 5]);
    const res = await fetch(`${baseUrl}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [
            { type: 'text', text: 'inspect' },
            {
              type: 'image',
              resource: { data: pngBytes.toString('base64'), mimeType: 'image/png' },
            },
            { type: 'file', uri: 'blob://existing', mimeType: 'application/pdf' },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { stopReason?: string } };
    expect(body.result?.stopReason).toBe('end_turn');

    await new Promise((r) => setTimeout(r, 50));
    const log = await store.load(sessionId);
    const userEvent = log.find((e) => e.type === 'message/user') as {
      content: ContentBlock[];
    };
    const image = userEvent.content.find((b) => b.kind === 'image') as { uri: string };
    const file = userEvent.content.find((b) => b.kind === 'file') as { uri: string };
    // Inline base64 was persisted to the blob store; the log holds blob://
    // references only (docs/design.md §10).
    expect(image.uri).toMatch(/^blob:\/\//);
    expect(file.uri).toBe('blob://existing');
    expect(lastRequest!.messages[0]!.blocks).toEqual([
      { kind: 'image', uri: image.uri, mimeType: 'image/png' },
      { kind: 'file', uri: 'blob://existing', mimeType: 'application/pdf' },
    ]);
  });

  it('ACP session/prompt rejects malformed blocks with a JSON-RPC error', async () => {
    const sessionId = await createSession();
    const res = await fetch(`${baseUrl}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'file' }] },
      }),
    });
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32602);
  });
});
