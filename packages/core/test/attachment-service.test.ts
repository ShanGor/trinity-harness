import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AttachmentService,
  LocalBlobStore,
  MemoryAttachmentCatalog,
  MemorySessionStore,
  readAttachmentBlob,
  LocalSandbox,
} from '../src/index.js';
import { toModelMessages } from '../src/loop/to-model-messages.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-paste-'));
  roots.push(root);
  const blobs = new LocalBlobStore(path.join(root, 'blobs'));
  const catalog = new MemoryAttachmentCatalog();
  const events = new MemorySessionStore();
  const service = new AttachmentService(blobs, catalog, events);
  const make = (sessionId = randomUUID()) => {
    mkdirSync(path.join(root, sessionId), { recursive: true });
    return {
      sessionId,
      operationId: randomUUID(),
      data: new TextEncoder().encode('  你好\r\nkeep whitespace  '),
      mimeType: 'text/plain',
      filename: 'pasted-text.txt',
      origin: 'paste' as const,
      workspaceRoot: path.join(root, sessionId),
    };
  };
  return { root, blobs, catalog, events, service, make };
}
it('shares one global original across sessions and MIME/filename metadata, with independent files and references', async () => {
  const { root, blobs, service, make } = await fixture();
  const first = make();
  const second = {
    ...make(),
    filename: 'other.png',
    mimeType: 'image/png',
    origin: 'file' as const,
  };
  const [a, b] = await Promise.all([service.upload(first), service.upload(second)]);
  expect(a.uri).not.toBe(b.uri);
  expect(await readdir(path.join(root, 'blobs', 'attachment-pool'))).toHaveLength(1);
  expect((await service.meta(first.sessionId, a.uri))?.mimeType).toBe('text/plain');
  expect((await service.meta(second.sessionId, b.uri))?.mimeType).toBe('image/png');
  await writeFile(path.join(first.workspaceRoot, a.workspacePath), 'edited');
  expect(await readFile(path.join(second.workspaceRoot, b.workspacePath))).toEqual(
    Buffer.from(first.data),
  );
  expect(await service.get(first.sessionId, a.uri)).toEqual(first.data);
  expect(await service.get(second.sessionId, a.uri)).toBeNull();
  await expect(
    readAttachmentBlob(
      blobs,
      service,
      first.sessionId,
      `blob://attachment-pool/${(await readdir(path.join(root, 'blobs', 'attachment-pool')))[0]}`,
    ),
  ).rejects.toThrow('private');
});
it('reconciles a lost receipt response without repeating a write and rejects changed operation input', async () => {
  const { service, events, make } = await fixture();
  const input = make();
  const append = events.append.bind(events);
  const spy = vi.spyOn(events, 'append').mockImplementationOnce(async (...args) => {
    await append(...args);
    throw new Error('response lost');
  });
  await expect(service.upload(input)).rejects.toThrow('response lost');
  const result = await service.upload(input);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(
    (await events.load(input.sessionId)).filter((e) => e.type === 'session/attachment'),
  ).toHaveLength(1);
  expect(await service.get(input.sessionId, result.uri)).toEqual(input.data);
  await expect(service.upload({ ...input, filename: 'changed.txt' })).rejects.toThrow(
    'different content',
  );
});
it('recovers materialization followed by failed append, preserving changed working copies', async () => {
  const { service, events, catalog, make } = await fixture();
  const input = make();
  vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('database unavailable'));
  await expect(service.upload(input)).rejects.toThrow('database unavailable');
  const result = await service.upload(input);
  const record = await catalog.find(input.sessionId, input.operationId);
  expect(record?.workspacePath).toBe(result.workspacePath);
  await writeFile(path.join(input.workspaceRoot, result.workspacePath), 'user edits');
  const again = await service.upload({ ...input, operationId: randomUUID() });
  expect(again.workspacePath).not.toBe(result.workspacePath);
  expect(await readFile(path.join(input.workspaceRoot, result.workspacePath), 'utf8')).toBe(
    'user edits',
  );
});
it('uses configured Sandbox and exposes text by workspace reference, never as provider media', async () => {
  const { service, events, make } = await fixture();
  const input = make();
  const sandbox = new LocalSandbox(input.workspaceRoot);
  const write = vi.spyOn(sandbox, 'writeBytes');
  const result = await service.upload({ ...input, sandbox });
  expect(write).toHaveBeenCalledTimes(1);
  await events.append(input.sessionId, [
    {
      type: 'message/user',
      eventId: randomUUID(),
      at: new Date().toISOString(),
      surfaceOp: 'append',
      content: [
        { kind: 'text', text: 'summarize' },
        { kind: 'file', uri: result.uri, mimeType: 'text/plain' },
      ],
    },
  ]);
  const projected = toModelMessages(await events.load(input.sessionId));
  expect(projected[0]?.blocks).toBeUndefined();
  expect(projected[0]?.content).toContain(result.workspacePath);
  expect(projected[0]?.content).not.toContain('你好');
});
it('rejects invalid UTF-8 before storage and cannot read an uncommitted attachment', async () => {
  const { service, catalog, make } = await fixture();
  const input = make();
  await expect(service.upload({ ...input, data: new Uint8Array([255]) })).rejects.toThrow();
  expect(await catalog.find(input.sessionId, input.operationId)).toBeNull();
});

it('restores exact pasted user-text provenance for tools while model messages keep only the attachment reference', async () => {
  const { CoreAgentLoop, CoreToolRegistry } = await import('../src/index.js');
  const { FakeLLM, toolCallThenFinish, textChunks } = await import('../src/testing/index.js');
  const { z } = await import('zod');
  const { service, events, make } = await fixture();
  const input = make();
  const uploaded = await service.upload(input);
  const tools = new CoreToolRegistry(new LocalSandbox(input.workspaceRoot));
  let original = '';
  tools.register({
    name: 'inspect_request',
    description: 'Inspect committed provenance',
    parameters: z.object({}),
    execute: async (_args, ctx) => {
      original = ctx.userRequest ?? '';
      return { value: 'ok', isError: false };
    },
  });
  const loop = new CoreAgentLoop({
    model: 'fake/model',
    store: events,
    workspaceRoot: input.workspaceRoot,
    tools,
    resolveBlob: async (uri) => {
      const bytes = await service.get(input.sessionId, uri);
      if (!bytes) throw new Error('missing');
      return bytes;
    },
    llm: new FakeLLM(
      (request) => {
        expect(JSON.stringify(request.messages)).not.toContain('你好');
        return toolCallThenFinish('inspect', 'inspect_request', {});
      },
      () => textChunks('done'),
    ),
  });
  await loop.run(
    input.sessionId,
    'Read this paste',
    { emit: () => undefined },
    {
      content: [
        { kind: 'text', text: 'Read this paste' },
        { kind: 'file', uri: uploaded.uri, mimeType: 'text/plain' },
      ],
    },
  );
  expect(original).toBe(`Read this paste\n${new TextDecoder().decode(input.data)}`);
});
