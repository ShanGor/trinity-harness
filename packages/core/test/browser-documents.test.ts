import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as htmlConverter from '../src/tools/browser-html-markdown.js';
import { BrowserDriverError } from '../src/tools/browser-driver-error.js';
import {
  browserDocumentGraphSchema,
  browserDocumentResultSchema,
  browserResultSchema,
  type BrowserBinding,
  type BrowserDocumentGraph,
  type BrowserRenderedDocument,
  type SessionEvent,
} from '@trinity-harness/contracts';
import {
  LocalBlobStore,
  LocalSandbox,
  MemorySessionStore,
  createBrowserTool,
} from '../src/index.js';
import {
  documentHash,
  persistDocumentGraph,
  loadDocumentCapture,
  documentResult,
  convertDocumentCapture,
  documentHtml,
  documentConversionHtml,
  validateDocumentGraph,
  readDocumentCapture,
  checkDocumentQuota,
} from '../src/tools/browser-documents.js';
import {
  browserArtifactUri,
  browserHash,
  loadBrowserObservation,
} from '../src/tools/browser-artifacts.js';
import { resolveBrowserSource } from '../src/tools/browser-evidence.js';
import { documentDigestScript } from '../src/tools/browser-document-digest.js';

const binding: BrowserBinding = {
  bindingId: 'binding',
  tabId: 'tab',
  documentRevision: 'revision',
  cliVersion: 'test',
  browserVersion: 'test',
  cliSession: 'test',
};
const meta = () => ({ eventId: randomUUID(), at: '2026-11-13T00:00:00.000Z' });
const doc = (id = 'd0'): BrowserRenderedDocument => ({
  documentId: id,
  parentDocumentId: null,
  ownerNodeId: null,
  url: 'https://example.com/',
  title: 'Report',
  revision: 'rev',
  nodes: [
    { id: 'n0', parentId: null, tag: 'body', path: [] },
    { id: 'n1', parentId: 'n0', tag: 'p', path: [0] },
    { id: 'n2', parentId: 'n1', tag: 'text', text: '中文 😀 source text', path: [0, 0] },
    { id: 'n3', parentId: 'n0', tag: 'iframe', path: [1] },
    { id: 'n4', parentId: 'n0', tag: 'p', path: [2] },
    { id: 'n5', parentId: 'n4', tag: 'text', text: 'After frame', path: [2, 0] },
  ],
  resources: [],
  exclusions: ['hidden', 'active-content', 'controls'],
  truncated: false,
});
const graph = (): BrowserDocumentGraph =>
  browserDocumentGraphSchema.parse({
    protocol: 'rendered-document-v1',
    buildId: 'trinity-document-v1',
    startedAt: meta().at,
    finishedAt: meta().at,
    documents: [doc()],
    omittedFrames: 0,
    stability: 'checked-interval',
  });
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'trinity-document-test-'));
  roots.push(root);
  return { root, blobs: new LocalBlobStore(join(root, 'blobs')) };
}
async function committed(blobs: LocalBlobStore, input = graph()) {
  const manifest = await persistDocumentGraph(
    input,
    binding,
    's',
    'capture-call',
    'capture',
    blobs,
  );
  const prompt = {
    ...meta(),
    type: 'message/user' as const,
    surfaceOp: 'append' as const,
    content: [{ kind: 'text' as const, text: 'Read report' }],
  };
  const events: SessionEvent[] = [
    prompt,
    {
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: 'capture-call',
      args: { operation: 'capture_document' },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'capture-call',
      isError: false,
      value: documentResult(manifest, 'capture_document', 'capture-call'),
    },
  ];
  return { manifest, events, prompt };
}
describe('rendered document integrity and offline conversion', () => {
  it.each(['', 'abc', '中文 😀', 'x'.repeat(9000)])(
    'renderer SHA-256 agrees with Node for %j',
    (text) => {
      const digest = Function(`return (${documentDigestScript})`)() as (text: string) => string;
      expect(digest(text)).toBe(createHash('sha256').update(text).digest('hex'));
    },
  );
  it('retains child document identity and inserts child content at its owner', async () => {
    const { blobs } = await setup();
    const input = graph();
    const child = doc('d1');
    child.parentDocumentId = 'd0';
    child.ownerNodeId = 'n3';
    child.url = 'https://child.example/report';
    child.nodes = child.nodes.slice(0, 3);
    child.nodes[2]!.text = 'Child table report';
    input.documents.push(child);
    const { manifest } = await committed(blobs, input);
    const result = convertDocumentCapture(manifest);
    expect(result.blocks.map((b) => b.text)).toEqual([
      '中文 😀 source text',
      'Child table report',
      'After frame',
    ]);
    expect(result.derivation?.mappings[1]?.documentId).toBe('d1');
    expect(documentHash(convertDocumentCapture(manifest))).toBe(documentHash(result));
  });
  it('does not authorize an orphan, a fork copy, a removed exchange, or corrupt bytes', async () => {
    const { blobs } = await setup();
    const { manifest, events, prompt } = await committed(blobs);
    await expect(loadDocumentCapture(blobs, [], 's', 'capture')).rejects.toMatchObject({
      code: 'ARTIFACT_UNAVAILABLE',
    });
    await expect(loadDocumentCapture(blobs, events, 'other', 'capture')).rejects.toMatchObject({
      code: 'ARTIFACT_UNAVAILABLE',
    });
    await expect(
      loadDocumentCapture(
        blobs,
        [
          ...events,
          { ...meta(), type: 'message/removed', promptId: prompt.eventId, role: 'assistant' },
        ],
        's',
        'capture',
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_UNAVAILABLE' });
    expect((await loadDocumentCapture(blobs, events, 's', 'capture')).hash).toBe(manifest.hash);
    const uri = `browser/s/capture/capture.json`;
    await blobs.put(uri, Buffer.from(JSON.stringify({ ...manifest, title: 'tampered' })), {
      mimeType: 'application/json',
    });
    // Unknown keys are stripped by Zod; tamper a hashed document field instead.
    await blobs.put(
      uri,
      Buffer.from(
        JSON.stringify({
          ...manifest,
          documents: [{ ...manifest.documents[0], title: 'tampered' }],
        }),
      ),
      { mimeType: 'application/json' },
    );
    await expect(loadDocumentCapture(blobs, events, 's', 'capture')).rejects.toMatchObject({
      code: 'ARTIFACT_UNAVAILABLE',
    });
  });
  it('never overwrites an existing capture ID', async () => {
    const { blobs } = await setup();
    await committed(blobs);
    await expect(
      persistDocumentGraph(graph(), binding, 's', 'another', 'capture', blobs),
    ).rejects.toMatchObject({ code: 'PERSIST_FAILED' });
  });
  it('uses exact Unicode HTML ranges and bounded literal search without network', async () => {
    const { blobs } = await setup();
    const { manifest } = await committed(blobs);
    const html = documentHtml(manifest.documents[0]!);
    const result = readDocumentCapture(manifest, 'd0', 0, '中文 😀');
    const range = result.ranges[0]!;
    expect(Array.from(html).slice(range.start, range.end).join('')).toBe(range.text);
    expect(range.text).toContain('中文 😀');
    expect(readDocumentCapture(manifest, 'd0', 0, 'missing').ranges).toEqual([]);
    expect(() => readDocumentCapture(manifest, 'missing', 0)).toThrow();
    expect(
      Buffer.byteLength(
        JSON.stringify({ ...documentResult(manifest, 'read_capture', 'read'), ...result }),
      ),
    ).toBeLessThan(8192);
  });
  it.each(['duplicate', 'parent', 'owner', 'depth', 'url', 'resource', 'limit'])(
    'rejects invalid %s graph before publication',
    (kind) => {
      const input = graph();
      const d = input.documents[0]!;
      if (kind === 'duplicate') d.nodes.push({ ...d.nodes[0]! });
      if (kind === 'parent') d.nodes[1]!.parentId = 'missing';
      if (kind === 'owner') {
        const c = doc('child');
        c.parentDocumentId = 'd0';
        c.ownerNodeId = 'n1';
        input.documents.push(c);
      }
      if (kind === 'depth')
        for (let i = 0; i < 85; i++)
          d.nodes.push({
            id: 'deep' + i,
            parentId: i ? 'deep' + (i - 1) : 'n0',
            tag: 'div',
            path: [],
          });
      if (kind === 'url') d.url = 'https://example.com/?token=secret';
      if (kind === 'resource')
        d.resources.push({ id: 'asset', nodeId: 'missing', role: 'image', state: 'captured' });
      if (kind === 'limit')
        for (let i = 0; i < 40; i++)
          d.nodes.push({
            id: 'big' + i,
            parentId: 'n0',
            tag: 'text',
            text: 'x'.repeat(64000),
            path: [i],
          });
      expect(() => validateDocumentGraph(input)).toThrow();
    },
  );
  it('bounds derived observations while retaining the original saved document', async () => {
    const input = graph();
    const d = input.documents[0]!;
    d.nodes = d.nodes.slice(0, 1);
    for (let i = 0; i < 10; i++)
      d.nodes.push(
        { id: 'p' + i, parentId: 'n0', tag: 'p', path: [i] },
        { id: 't' + i, parentId: 'p' + i, tag: 'text', text: '大'.repeat(30000), path: [i, 0] },
      );
    const { blobs } = await setup();
    const { manifest } = await committed(blobs, input);
    const result = convertDocumentCapture(manifest);
    expect(result.captureTruncated).toBe(true);
    expect(result.readiness).toBe('partial');
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(manifest.documents[0]!.nodes).toHaveLength(21);
  });
  it('counts interrupted writer calls toward the durable quota', () => {
    const events: SessionEvent[] = Array.from({ length: 9 }, (_, i) => ({
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: String(i),
      args: { operation: 'capture_document' },
    }));
    expect(() => checkDocumentQuota(events)).toThrow(/quota/);
  });
  it('exports inert HTML with no remote loads, form values or executable attributes', () => {
    const d = doc();
    d.nodes.push(
      { id: 'a', parentId: 'n0', tag: 'a', href: 'https://example.com/', path: [3] },
      { id: 'text', parentId: 'a', tag: 'text', text: '<script>alert(1)</script>', path: [3, 0] },
    );
    const html = documentHtml(d);
    expect(html).toContain('default-src');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script|<iframe|\shref=|\ssrc="https|\son\w+=/);
  });
  it('rewrites captured media URLs to deduplicated local files in every exported HTML representation', async () => {
    const input = graph();
    const root = input.documents[0]!;
    const pixels =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
    root.nodes.push(
      { id: 'image', parentId: 'n0', tag: 'img', resourceId: 'image', alt: 'Figure', path: [3] },
      {
        id: 'image-link',
        parentId: 'n0',
        tag: 'a',
        href: 'https://example.com/media/figure.png',
        path: [4],
      },
      {
        id: 'image-label',
        parentId: 'image-link',
        tag: 'text',
        text: 'Original figure',
        path: [4, 0],
      },
      {
        id: 'missing',
        parentId: 'n0',
        tag: 'img',
        resourceId: 'missing',
        alt: 'Unavailable figure',
        path: [5],
      },
    );
    root.resources = [
      {
        id: 'image',
        nodeId: 'image',
        role: 'image',
        state: 'captured',
        url: 'https://example.com/media/figure.png',
        mimeType: 'image/png',
        data: pixels,
      },
      {
        id: 'missing',
        nodeId: 'missing',
        role: 'image',
        state: 'blocked',
        url: 'https://remote.example/protected.png',
      },
    ];
    const { blobs } = await setup();
    const { manifest } = await committed(blobs, input);
    const local = 'media/' + documentHash(pixels) + '.png';
    for (const html of [documentConversionHtml(manifest), documentConversionHtml(manifest, 'd0')]) {
      expect(html).toContain(`src="${local}"`);
      expect(html).toContain(`href="${local}"`);
      expect(html).not.toMatch(/src="https?:|src="data:|srcset=|style=/);
      expect(html).not.toContain('https://remote.example/protected.png');
      expect(html).toContain('Unavailable figure [Image unavailable offline]');
    }
    expect(manifest.documents[0]!.resources[0]!.url).toBe('https://example.com/media/figure.png');
  });
  it('revalidates capture and mapping on every derived citation', async () => {
    const { blobs } = await setup();
    const { manifest, events } = await committed(blobs);
    const converted = convertDocumentCapture(manifest);
    const payload = {
      ...converted,
      observationId: 'obs',
      sessionId: 's',
      bindingId: 'binding',
      tabId: 'tab',
      documentRevision: 'revision',
      cliVersion: 'test',
      browserVersion: 'test',
      capturedAt: meta().at,
    };
    const observation = { ...payload, hash: browserHash(payload) };
    await blobs.put(
      browserArtifactUri('s', 'obs').slice(7),
      Buffer.from(JSON.stringify(observation)),
      { mimeType: 'application/json' },
    );
    const b = converted.blocks[0]!;
    const text = b.text;
    const start = 0,
      end = Array.from(text).length;
    const delivery = {
      kind: 'browser-result-v1',
      operation: 'extract_capture',
      sessionId: 's',
      callId: 'extract',
      observationId: 'obs',
      artifactUri: browserArtifactUri('s', 'obs'),
      url: observation.url,
      title: observation.title,
      capturedAt: observation.capturedAt,
      bindingId: 'binding',
      tabId: 'tab',
      documentRevision: 'revision',
      readiness: 'ready',
      saved: true,
      captureTruncated: false,
      representation: 'documentation',
      scope: observation.scope,
      exclusions: [],
      publishedAt: null,
      outline: [],
      duplicateSuppressed: false,
      outputTruncated: false,
      blocks: [{ id: b.id, kind: b.kind, text, start, end }],
      receipt: [{ blockId: b.id, start, end }],
      continuation: null,
    };
    events.push(
      {
        ...meta(),
        type: 'tool/call',
        name: 'browser',
        callId: 'extract',
        args: { operation: 'extract_capture', captureId: 'capture' },
      },
      { ...meta(), type: 'tool/result', callId: 'extract', isError: false, value: delivery },
    );
    expect(
      (await resolveBrowserSource({ observationId: 'obs', blockId: b.id }, events, 0, 's', blobs))
        .quote,
    ).toBe(text);
    const tampered = { ...observation, blocks: [{ ...b, text: 'Invented text' }] };
    tampered.hash = browserHash(tampered);
    await blobs.put(
      browserArtifactUri('s', 'obs').slice(7),
      Buffer.from(JSON.stringify(tampered)),
      { mimeType: 'application/json' },
    );
    await expect(loadBrowserObservation(blobs, events, 's', 'obs')).rejects.toThrow(/mapping/);
  });
  it('runs saved tools without a browser and policy-gates safe workspace exports', async () => {
    const { root, blobs } = await setup();
    const { events } = await committed(blobs);
    const store = new MemorySessionStore();
    await store.append('s', events);
    const tool = createBrowserTool({ store, blobs, now: () => new Date(meta().at) });
    await mkdir(join(root, 'workspace'));
    const sandbox = new LocalSandbox(join(root, 'workspace'));
    const run = async (callId: string, args: unknown, permissionGranted = false) => {
      await store.append('s', [{ ...meta(), type: 'tool/call', name: 'browser', callId, args }]);
      const result = await tool.execute(args, {
        sessionId: 's',
        callId,
        sandbox,
        workspaceRoot: join(root, 'workspace'),
        permissionGranted,
      });
      await store.append('s', [{ ...meta(), type: 'tool/result', callId, ...result }]);
      return result;
    };
    expect(
      (await run('read', { operation: 'read_capture', captureId: 'capture', documentId: 'd0' }))
        .isError,
    ).toBe(false);
    const extracted = await run('extract', { operation: 'extract_capture', captureId: 'capture' });
    expect(extracted.isError).toBe(false);
    expect(browserResultSchema.parse(extracted.value).receipt.length).toBeGreaterThan(0);
    expect(
      (await run('denied', { operation: 'export_capture', captureId: 'capture' })).value,
    ).toMatchObject({ code: 'NOT_AUTHORIZED' });
    const exported = await run(
      'export',
      { operation: 'export_capture', captureId: 'capture' },
      true,
    );
    expect(exported.isError, JSON.stringify(exported.value)).toBe(false);
    const value = browserDocumentResultSchema.parse(exported.value);
    expect(value.path).toMatch(/^browser-capture-/);
    expect((await sandbox.readFile(value.path + '/d0.html')).content).toContain(
      'Content-Security-Policy',
    );
    expect(
      (await run('export', { operation: 'export_capture', captureId: 'capture' }, true)).isError,
    ).toBe(true);
  });
  it('pages conversion offline without losing or repeating large-document text', async () => {
    const input = graph(),
      d = input.documents[0]!;
    d.nodes = d.nodes.slice(0, 1);
    for (let i = 0; i < 12; i++)
      d.nodes.push(
        { id: 'p' + i, parentId: 'n0', tag: 'p', path: [i] },
        {
          id: 't' + i,
          parentId: 'p' + i,
          tag: 'text',
          text: String(i) + ':' + '内容😀'.repeat(8000),
          path: [i, 0],
        },
      );
    const { blobs } = await setup();
    const { manifest } = await committed(blobs, input);
    let offset = 0;
    const pages: string[] = [];
    do {
      const page = convertDocumentCapture(manifest, undefined, offset);
      pages.push(...page.blocks.map((b) => b.text));
      const next = page.derivation!.nextOffset;
      if (next === null) break;
      expect(next).toBeGreaterThan(offset);
      offset = next;
    } while (offset > 0);
    expect(pages.join('')).toBe(
      d.nodes
        .filter((n) => n.tag === 'text')
        .map((n) => n.text)
        .join(''),
    );
  });
  it('preserves nested list order, list numbering and code whitespace', async () => {
    const input = graph(),
      d = input.documents[0]!;
    d.nodes = [
      { id: 'root', parentId: null, tag: 'body', path: [] },
      { id: 'list', parentId: 'root', tag: 'ol', path: [0], listStart: 3 },
      { id: 'item', parentId: 'list', tag: 'li', path: [0, 0] },
      { id: 'text', parentId: 'item', tag: 'text', text: 'Parent', path: [0, 0, 0] },
      { id: 'nested', parentId: 'item', tag: 'ul', path: [0, 0, 1] },
      { id: 'child', parentId: 'nested', tag: 'li', path: [0, 0, 1, 0] },
      { id: 'childtext', parentId: 'child', tag: 'text', text: 'Child', path: [0, 0, 1, 0, 0] },
      { id: 'code', parentId: 'root', tag: 'pre', path: [1] },
      { id: 'codetext', parentId: 'code', tag: 'text', text: '  a\n    b', path: [1, 0] },
    ];
    const { blobs } = await setup();
    const { manifest } = await committed(blobs, input);
    const page = convertDocumentCapture(manifest);
    expect(page.blocks.map((b) => b.text)).toEqual(['Parent', 'Child', '  a\n    b']);
    expect(page.blocks[0]).toMatchObject({ ordinal: 3, listDepth: 0 });
    expect(page.blocks[1]).toMatchObject({ listDepth: 1 });
  });
  it('retains all table rows across bounded table blocks', async () => {
    const input = graph(),
      d = input.documents[0]!;
    d.nodes = [
      { id: 'root', parentId: null, tag: 'body', path: [] },
      { id: 'table', parentId: 'root', tag: 'table', path: [0] },
    ];
    for (let i = 0; i < 205; i++)
      d.nodes.push(
        { id: 'r' + i, parentId: 'table', tag: 'tr', path: [0, i] },
        { id: 'c' + i, parentId: 'r' + i, tag: 'td', path: [0, i, 0] },
        { id: 't' + i, parentId: 'c' + i, tag: 'text', text: 'Cell ' + i, path: [0, i, 0, 0] },
      );
    const { blobs } = await setup();
    const { manifest } = await committed(blobs, input);
    const page = convertDocumentCapture(manifest);
    expect(page.blocks).toHaveLength(3);
    expect(page.blocks.flatMap((b) => b.rows ?? [])).toHaveLength(205);
    expect(page.captureTruncated).toBe(false);
  });
  it('rejects tampered saved HTML even when the graph manifest is intact', async () => {
    const { blobs } = await setup();
    const { events } = await committed(blobs);
    await blobs.put('browser/s/capture/capture/d0.html', Buffer.from('<p>tampered</p>'), {
      mimeType: 'text/html',
    });
    await expect(loadDocumentCapture(blobs, events, 's', 'capture')).rejects.toMatchObject({
      code: 'ARTIFACT_UNAVAILABLE',
    });
  });
  it('blocks retry/amend suppressed captures and durable repeated attempts', async () => {
    const { blobs } = await setup();
    const { events, prompt } = await committed(blobs);
    await expect(
      loadDocumentCapture(
        blobs,
        [
          ...events,
          {
            ...meta(),
            type: 'message/user',
            surfaceOp: 'append',
            revision: { kind: 'amend', promptId: prompt.eventId },
            content: [{ kind: 'text', text: 'Correction' }],
          },
        ],
        's',
        'capture',
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_UNAVAILABLE' });
    const calls: SessionEvent[] = Array.from({ length: 3 }, (_, i) => ({
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: 'capture' + i,
      args: { operation: 'capture_document' },
    }));
    expect(() => checkDocumentQuota(calls)).toThrow(/recovery quota/);
    // Unrelated tools cannot mint browser recovery authority.
    calls.push({
      ...meta(),
      type: 'tool/result',
      callId: 'unrelated',
      isError: false,
      value: { kind: 'browser-result-v1', operation: 'navigate' },
    });
    expect(() => checkDocumentQuota(calls)).toThrow(/recovery quota/);
    calls.push({
      ...meta(),
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'New authorized request' }],
    });
    expect(() => checkDocumentQuota(calls)).not.toThrow();
  });
  it('revokes saved delivery when the source is removed during artifact transfer', async () => {
    const { root, blobs } = await setup();
    const { events, prompt } = await committed(blobs);
    const store = new MemorySessionStore();
    await store.append('s', [
      ...events,
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Read saved report' }],
      },
    ]);
    const original = blobs.get.bind(blobs);
    let removed = false;
    const spy = vi.spyOn(blobs, 'get').mockImplementation(async (uri) => {
      const bytes = await original(uri);
      if (uri.endsWith('.html') && !removed) {
        removed = true;
        await store.append('s', [
          { ...meta(), type: 'message/removed', promptId: prompt.eventId, role: 'user' },
        ]);
      }
      return bytes;
    });
    try {
      const tool = createBrowserTool({ store, blobs, now: () => new Date(meta().at) });
      const result = await tool.execute(
        { operation: 'read_capture', captureId: 'capture', documentId: 'd0' },
        { sessionId: 's', callId: 'read', workspaceRoot: root, sandbox: new LocalSandbox(root) },
      );
      expect(result.isError).toBe(true);
      expect(result.value).toMatchObject({ code: 'ARTIFACT_UNAVAILABLE' });
      expect(JSON.stringify(result)).not.toContain('中文');
    } finally {
      spy.mockRestore();
    }
  });
  it('stops later export writes after a concurrent source deletion', async () => {
    const { root, blobs } = await setup();
    const { events, prompt } = await committed(blobs);
    const store = new MemorySessionStore();
    await store.append('s', [
      ...events,
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Export saved report' }],
      },
    ]);
    const sandbox = new LocalSandbox(root),
      original = sandbox.writeBytes.bind(sandbox);
    let writes = 0;
    const spy = vi.spyOn(sandbox, 'writeBytes').mockImplementation(async (path, bytes) => {
      await original(path, bytes);
      if (++writes === 1)
        await store.append('s', [
          { ...meta(), type: 'message/removed', promptId: prompt.eventId, role: 'user' },
        ]);
    });
    try {
      const tool = createBrowserTool({ store, blobs, now: () => new Date(meta().at) });
      const result = await tool.execute(
        { operation: 'export_capture', captureId: 'capture' },
        { sessionId: 's', callId: 'export', permissionGranted: true, workspaceRoot: root, sandbox },
      );
      expect(result.isError).toBe(true);
      expect(result.value).toMatchObject({ code: 'ARTIFACT_UNAVAILABLE', effect: 'unknown' });
      expect(writes).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it.each([
    'extract_capture',
    'read_capture',
    'search_capture',
    'export_capture',
    'export_markdown',
  ])(
    'explains the missing capture capability prerequisite for %s without browser or workspace effects',
    async (operation) => {
      const { root, blobs } = await setup();
      const store = new MemorySessionStore();
      const sandbox = new LocalSandbox(root);
      const exec = vi.spyOn(sandbox, 'execArgv');
      const write = vi.spyOn(sandbox, 'writeBytes');
      const tool = createBrowserTool({ store, blobs, now: () => new Date(meta().at) });
      expect(tool.parameters.safeParse({ operation: 'capture_document' }).success).toBe(false);
      // This reproduces the failed session: an observation-shaped UUID is not a capture receipt.
      const args = {
        operation,
        captureId: 'd78f5288-608a-4b82-b610-7914b5302b90',
        ...(['read_capture', 'search_capture'].includes(operation) ? { documentId: 'd0' } : {}),
        ...(operation === 'search_capture' ? { query: 'article' } : {}),
      };
      expect(tool.parameters.safeParse(args).success).toBe(true);
      const result = await tool.execute(args, {
        sessionId: 's',
        callId: 'export',
        permissionGranted: true,
        workspaceRoot: root,
        sandbox,
      });
      expect(result.value).toMatchObject({
        code: 'ARTIFACT_UNAVAILABLE',
        effect: 'none',
        recovery: 'conclude',
        message: expect.stringContaining('no live rendered-document capture capability'),
      });
      expect(result.value).toMatchObject({
        message: expect.stringContaining('Do not retry the same ID'),
      });
      expect(exec).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );
  it('distinguishes a missing capture receipt from unavailable live capture', async () => {
    const { root, blobs } = await setup();
    const tool = createBrowserTool({
      store: new MemorySessionStore(),
      blobs,
      runtime: { execute: vi.fn() },
      now: () => new Date(meta().at),
    });
    const result = await tool.execute(
      { operation: 'export_markdown', captureId: 'missing' },
      {
        sessionId: 's',
        callId: 'export',
        permissionGranted: true,
        workspaceRoot: root,
        sandbox: new LocalSandbox(root),
      },
    );
    expect(result.value).toMatchObject({
      code: 'ARTIFACT_UNAVAILABLE',
      effect: 'none',
      message: expect.stringContaining('capture_document is required before export'),
    });
    expect(JSON.stringify(result.value)).not.toContain(
      'no live rendered-document capture capability',
    );
  });
  it('automatically advertises capture with a configured runtime and preserves capability refusal', async () => {
    const { root, blobs } = await setup();
    const refusal = {
      isError: true,
      value: {
        kind: 'browser-error-v1',
        operation: 'capture_document',
        code: 'DISABLED',
        effect: 'none',
        message: 'Installed binary lacks rendered-document-v1 capability.',
      },
    };
    const runtime = { execute: vi.fn().mockResolvedValue(refusal) };
    const tool = createBrowserTool({
      store: new MemorySessionStore(),
      blobs,
      runtime,
      now: () => new Date(meta().at),
    });
    expect(tool.parameters.safeParse({ operation: 'capture_document' }).success).toBe(true);
    const result = await tool.execute(
      { operation: 'capture_document' },
      {
        sessionId: 's',
        callId: 'capture',
        workspaceRoot: root,
        sandbox: new LocalSandbox(root),
      },
    );
    expect(result).toEqual(refusal);
    expect(runtime.execute).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: 's',
        callId: 'capture',
        args: { operation: 'capture_document' },
        permissionGranted: false,
      },
      undefined,
    );
  });
  it('rejects disabled capture without touching a browser', async () => {
    const { blobs } = await setup();
    const tool = createBrowserTool({
      store: new MemorySessionStore(),
      blobs,
      now: () => new Date(),
    });
    const result = await tool.execute(
      { operation: 'capture_document' },
      {
        sessionId: 's',
        callId: 'call',
        sandbox: new LocalSandbox('/unused'),
        workspaceRoot: '/unused',
      },
    );
    expect(result.value).toMatchObject({ code: 'DISABLED', effect: 'none' });
  });
});

async function exportFixture(input = graph()) {
  const { root, blobs } = await setup();
  const { events, prompt } = await committed(blobs, input);
  const store = new MemorySessionStore();
  await store.append('s', events);
  const sandbox = new LocalSandbox(root);
  const tool = createBrowserTool({ store, blobs, now: () => new Date(meta().at) });
  const run = (permissionGranted = true, signal?: AbortSignal) =>
    tool.execute(
      { operation: 'export_markdown', captureId: 'capture' },
      {
        sessionId: 's',
        callId: 'markdown',
        permissionGranted,
        workspaceRoot: root,
        sandbox,
        signal,
      },
    );
  return { root, sandbox, store, prompt, run };
}

describe('HTML-first Turndown export', () => {
  it('materializes HTML and provenance before conversion and never invokes a native converter', async () => {
    const fixture = await exportFixture();
    const read = fixture.sandbox.readFile.bind(fixture.sandbox);
    const spy = vi.spyOn(fixture.sandbox, 'execArgv');
    let sawSavedInput = false;
    vi.spyOn(fixture.sandbox, 'readFile').mockImplementation(async (path, opts) => {
      if (path.endsWith('/content.html')) {
        sawSavedInput = true;
        const provenance = JSON.parse(
          (await read(path.replace('/content.html', '/manifest.json'))).content,
        );
        expect(provenance.conversion).toBeNull();
        // Force version-fenced pages, including Unicode split boundaries.
        return read(path, { ...opts, maxBytes: 32 });
      }
      return read(path, opts);
    });
    const result = await fixture.run(true, new AbortController().signal);
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    expect(sawSavedInput).toBe(true);
    expect(spy.mock.calls.every(([command]) => command === 'node')).toBe(true);
    expect(result.value).toMatchObject({
      converter: 'turndown',
      coverage: 'unverified',
      captureId: 'capture',
      outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputBytes: expect.any(Number),
      limitations: {
        omittedFrames: 0,
        truncatedDocuments: 0,
        inlineSvg: expect.any(Number),
        unavailableResources: expect.any(Number),
      },
    });
    const value = result.value as { path: string; bundlePath: string; inputHash: string };
    expect((await read(value.path)).content).toContain('中文 😀 source text');
    expect(JSON.parse((await read(value.bundlePath + '/manifest.json')).content)).toMatchObject({
      input: { sha256: value.inputHash },
      conversion: {
        converter: 'turndown',
        version: htmlConverter.browserHtmlConverterVersion,
        extensions: ['gfm'],
      },
    });
    expect((await fixture.run()).isError).toBe(true);
  });

  it('does no command or file work without workspace authorization', async () => {
    const fixture = await exportFixture();
    const exec = vi.spyOn(fixture.sandbox, 'execArgv');
    const write = vi.spyOn(fixture.sandbox, 'writeBytes');
    expect((await fixture.run(false)).value).toMatchObject({
      code: 'NOT_AUTHORIZED',
      effect: 'none',
    });
    expect(exec).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['NOT_EXECUTED', 'LIMIT_REACHED'] as const)(
    'retains HTML without partial Markdown on %s',
    async (code) => {
      const fixture = await exportFixture();
      vi.spyOn(htmlConverter, 'browserHtmlToMarkdown').mockRejectedValue(
        new BrowserDriverError(code, 'Saved HTML remains available.'),
      );
      const writes = vi.spyOn(fixture.sandbox, 'writeBytes');
      expect((await fixture.run()).value).toMatchObject({ code, effect: 'unknown' });
      expect(writes.mock.calls.some(([path]) => path.endsWith('/content.html'))).toBe(true);
      expect(writes.mock.calls.some(([path]) => path.endsWith('/content.md'))).toBe(false);
    },
  );

  it.each(['revoke', 'change', 'cancel'] as const)(
    'does not publish Markdown after %s during conversion',
    async (mode) => {
      const fixture = await exportFixture();
      const controller = new AbortController();
      const convert = htmlConverter.browserHtmlToMarkdown;
      vi.spyOn(htmlConverter, 'browserHtmlToMarkdown').mockImplementation(async (html, signal) => {
        const result = await convert(html, signal);
        if (mode === 'revoke')
          await fixture.store.append('s', [
            { ...meta(), type: 'message/removed', promptId: fixture.prompt.eventId, role: 'user' },
          ]);
        if (mode === 'change') {
          const path =
            'browser-capture-' + createHash('sha256').update('markdown').digest('hex').slice(0, 32);
          await fixture.sandbox.writeBytes(path + '/content.html', Buffer.from('Changed input'));
        }
        if (mode === 'cancel') controller.abort();
        return result;
      });
      const writes = vi.spyOn(fixture.sandbox, 'writeBytes');
      expect((await fixture.run(true, controller.signal)).value).toMatchObject({
        code: mode === 'cancel' ? 'CANCELLED' : 'ARTIFACT_UNAVAILABLE',
        effect: 'unknown',
      });
      expect(writes.mock.calls.some(([path]) => path.endsWith('/content.md'))).toBe(false);
    },
  );

  it('converts real nested-frame HTML and preserves source links and local media', async () => {
    const input = graph();
    const child = doc('child');
    child.parentDocumentId = 'd0';
    child.ownerNodeId = 'n3';
    child.nodes = [
      { id: 'n0', parentId: null, tag: 'body', path: [] },
      { id: 'n1', parentId: 'n0', tag: 'h2', path: [0] },
      { id: 'n2', parentId: 'n1', tag: 'text', text: 'Child 中文 report', path: [0, 0] },
      { id: 'n3', parentId: 'n0', tag: 'a', href: 'https://example.com/source', path: [1] },
      { id: 'n4', parentId: 'n3', tag: 'text', text: 'Primary source', path: [1, 0] },
      {
        id: 'n5',
        parentId: 'n0',
        tag: 'img',
        alt: 'Captured figure',
        resourceId: 'image',
        path: [2],
      },
    ];
    child.resources = [
      {
        id: 'image',
        nodeId: 'n5',
        role: 'image',
        state: 'captured',
        mimeType: 'image/png',
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      },
    ];
    input.documents.push(child);
    const fixture = await exportFixture(input);
    const result = await fixture.run();
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    const value = result.value as { path: string; bundlePath: string };
    const markdown = (await fixture.sandbox.readFile(value.path)).content;
    expect(markdown).toContain('## Child 中文 report');
    expect(markdown).toContain('[Primary source](https://example.com/source)');
    expect(markdown).toMatch(/!\[Captured figure\]\(media\/[a-f0-9]+\.png\)/);
    expect(markdown.indexOf('source text')).toBeLessThan(markdown.indexOf('Child 中文 report'));
    expect(markdown.indexOf('Child 中文 report')).toBeLessThan(markdown.indexOf('After frame'));
    const image = documentHash(child.resources[0]!.data!) + '.png';
    expect(
      (await fixture.sandbox.readBytes(value.bundlePath + '/media/' + image, 1000)).length,
    ).toBeGreaterThan(0);
  });
});
