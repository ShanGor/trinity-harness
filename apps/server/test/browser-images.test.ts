import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  LocalBlobStore,
  browserHash,
} from '@trinity-harness/core';
import { FakeLLM, FakeSandbox, textChunks } from '@trinity-harness/core/testing';
import { browserObservationSchema, browserResultSchema } from '@trinity-harness/contracts';
import { buildServer } from '../src/index.js';
it('serves only committed intact session screenshots through the dedicated evidence route', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-browser-images-'));
  const store = new MemorySessionStore(),
    blobs = new LocalBlobStore(root);
  const app = await buildServer({
    store,
    blobs,
    workspaceRoot: root,
    createLoop: () =>
      new CoreAgentLoop({
        store,
        tools: new CoreToolRegistry(new FakeSandbox()),
        llm: new FakeLLM(() => textChunks('done')),
        model: 'fake/model',
        workspaceRoot: root,
      }),
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    const { sessionId } = response.json<{ sessionId: string }>();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const observationId = 'shot',
      uri = `blob://browser/${sessionId}/shot.png`,
      artifactUri = `blob://browser/${sessionId}/shot.json`;
    const image = {
      uri,
      hash: createHash('sha256').update(bytes).digest('hex'),
      mimeType: 'image/png' as const,
      bytes: bytes.length,
      width: 1,
      height: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      scale: 1 as const,
    };
    const payload = {
      schemaVersion: 1 as const,
      extractorVersion: 'semantic-v1' as const,
      url: 'https://example.com/',
      title: 'Screenshot',
      publishedAt: null,
      readiness: 'ready' as const,
      representation: 'accessibility' as const,
      scope: 'owned-tab',
      exclusions: [],
      blocks: [],
      captureTruncated: false,
      observationId,
      sessionId,
      bindingId: 'binding',
      tabId: 'tab',
      documentRevision: 'revision',
      cliVersion: '0.38.2',
      browserVersion: 'Chrome',
      capturedAt: '2026-01-01T00:00:00.000Z',
      image,
    };
    const observation = browserObservationSchema.parse({ ...payload, hash: browserHash(payload) });
    await blobs.put(uri.slice(7), bytes, { mimeType: 'image/png' });
    await blobs.put(artifactUri.slice(7), new TextEncoder().encode(JSON.stringify(observation)), {
      mimeType: 'application/json',
    });
    const route = `/api/sessions/${sessionId}/browser-images/${observationId}`;
    expect((await app.inject({ method: 'GET', url: route })).statusCode).toBe(404);
    const meta = () => ({ eventId: crypto.randomUUID(), at: payload.capturedAt });
    const value = browserResultSchema.parse({
      ...payload,
      kind: 'browser-result-v1',
      operation: 'screenshot',
      callId: 'shot',
      artifactUri,
      saved: false,
      outline: [],
      duplicateSuppressed: false,
      outputTruncated: false,
      receipt: [],
      continuation: null,
    });
    await store.append(sessionId, [
      {
        ...meta(),
        type: 'tool/call',
        callId: 'shot',
        name: 'browser',
        args: { operation: 'screenshot' },
      },
      { ...meta(), type: 'tool/result', callId: 'shot', value, isError: false },
    ]);
    const served = await app.inject({ method: 'GET', url: route });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(
      (await app.inject({ method: 'GET', url: `/api/blobs/browser/${sessionId}/shot.png` }))
        .statusCode,
    ).toBe(403);
    const other = (await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).json<{
      sessionId: string;
    }>().sessionId;
    expect(
      (await app.inject({ method: 'GET', url: `/api/sessions/${other}/browser-images/shot` }))
        .statusCode,
    ).toBe(404);
    await blobs.put(uri.slice(7), new Uint8Array([0, 0, 0, 0]), { mimeType: 'image/png' });
    expect((await app.inject({ method: 'GET', url: route })).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
