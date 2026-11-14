// @vitest-environment jsdom
import { canonicalBrowserJson } from '../src/tools/browser-artifacts.js';
import { readFileSync } from 'node:fs';
import {
  documentHtml,
  documentConversionHtml,
  documentResult,
  persistDocumentGraph,
  validateDocumentGraph,
} from '../src/tools/browser-documents.js';
import { browserHtmlToMarkdown } from '../src/tools/browser-html-markdown.js';
import { LocalBlobStore } from '../src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserRenderedDocumentSchema,
  browserPresentationSchema,
  browserVectorAttributesSchema,
} from '@trinity-harness/contracts';
import {
  documentCaptureScript,
  documentChunkScript,
  documentReleaseScript,
} from '../src/tools/browser-document-script.js';
import { captureRenderedDocuments } from '../src/tools/browser-document-driver.js';
import type { ZendriverClient } from '../src/tools/zendriver-mcp.js';

const browser = globalThis as unknown as { document: Document; window: Window & typeof globalThis };
const key = '__trinity_fixture';
beforeEach(() => {
  browser.document.documentElement.innerHTML =
    '<head><title>Fixture</title></head><body><p>Mounted text 😀</p></body>';
  vi.spyOn(browser.window.Element.prototype, 'getClientRects').mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});
afterEach(() => {
  browser.window.eval(documentReleaseScript(key, false));
  vi.restoreAllMocks();
});
function snapshot() {
  const header = browser.window.eval(documentCaptureScript(key, 'rev')) as {
    length?: number;
    bytes?: number;
    denied?: boolean;
  };
  if (header.denied) return { header };
  let text = '';
  for (let offset = 0; offset < header.length!; offset += 8000)
    text += (browser.window.eval(documentChunkScript(key, 'rev', offset)) as { text: string }).text;
  const doc = browserRenderedDocumentSchema.parse({
    ...JSON.parse(text),
    url: 'https://example.com/',
    documentId: 'd0',
    parentDocumentId: null,
    ownerNodeId: null,
  });
  return { header, doc, text };
}
describe('bounded privacy-safe renderer serialization', () => {
  it('filters scripts, hidden content, form values and attributes before any transfer', () => {
    browser.document.body.innerHTML =
      '<main><h1>Report</h1><p onclick="steal()">Visible <a href="javascript:steal()">text</a><span hidden>hidden-secret</span></p><script>private-token</script><input type="hidden" value="secret-value"><iframe srcdoc="secret-raw"></iframe></main>';
    const { doc, text } = snapshot();
    expect(doc?.nodes.some((n) => n.tag === 'iframe')).toBe(true);
    expect(text).not.toMatch(/hidden-secret|private-token|secret-value|secret-raw|steal/);
    expect(text).toContain('Visible ');
  });
  it('resolves relative media references against the captured document base URL', () => {
    browser.document.head.innerHTML = '<base href="https://example.com/reports/">';
    browser.document.body.innerHTML =
      '<img src="../media/figure.png"><a href="../media/figure.png">Figure</a>';
    const { doc } = snapshot();
    expect(doc!.resources[0]!.url).toBe('https://example.com/media/figure.png');
    expect(doc!.nodes.find((node) => node.tag === 'a')!.href).toBe(
      'https://example.com/media/figure.png',
    );
  });
  it.each([
    '<input type="password" value="secret">',
    '<div contenteditable="true">private draft</div>',
    '<textarea name="token">secret</textarea>',
    '<div contenteditable="true"><img src="https://example.com/"></div>',
  ])('denies populated protected controls: %s', (html) => {
    browser.document.body.innerHTML = html + '<p>Public article</p>';
    expect(snapshot().header.denied).toBe(true);
  });
  it('retains public text with an empty comment editor and excludes editor content', () => {
    browser.document.body.innerHTML = '<p>Article</p><div contenteditable="true"><p><br></p></div>';
    const { doc } = snapshot();
    expect(doc?.nodes.filter((n) => n.tag === 'text').map((n) => n.text)).toEqual(['Article']);
  });
  it('captures open shadow structure and below-viewport mounted content', () => {
    const host = browser.document.createElement('div');
    browser.document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow text</p><iframe></iframe>';
    const { doc } = snapshot();
    expect(doc?.nodes.some((n) => n.tag === 'shadow')).toBe(true);
    expect(doc?.nodes.some((n) => n.text === 'Shadow text')).toBe(true);
    expect(doc?.nodes.find((n) => n.tag === 'iframe')?.path).toContain(-1);
  });
  it('preserves visible slotted light DOM within its shadow placement', () => {
    const host = browser.document.createElement('div');
    host.innerHTML = '<p>Slotted source</p>';
    browser.document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<section><slot></slot></section>';
    const { doc } = snapshot();
    expect(doc?.nodes.some((n) => n.text === 'Slotted source')).toBe(true);
    const slotted = doc!.nodes.find((n) => n.text === 'Slotted source')!;
    expect(slotted.path).not.toContain(-1);
  });
  it('denies protected controls inside open shadow roots', () => {
    const host = browser.document.createElement('div');
    browser.document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<input type="password" value="secret">';
    expect(snapshot().header.denied).toBe(true);
  });
  it('detects mutation between chunks and cleans up private capture state', () => {
    snapshot();
    browser.document.body.append(browser.document.createElement('p'));
    expect(browser.window.eval(documentChunkScript(key, 'rev', 0))).toEqual({ stale: true });
    browser.window.eval(documentReleaseScript(key, false));
    expect(browser.window.eval(documentChunkScript(key, 'rev', 0))).toEqual({ stale: true });
  });
  it('expires transient state even when control fencing prevents explicit cleanup', () => {
    const expiry = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(expiry.signal);
    snapshot();
    expiry.abort();
    expect(browser.window.eval(documentChunkScript(key, 'rev', 0))).toEqual({ stale: true });
  });
  it('bounds very large text before constructing a serialized document', () => {
    browser.document.body.innerHTML = '<p></p>';
    browser.document.querySelector('p')!.textContent = 'x'.repeat(1000000);
    const { doc, text } = snapshot();
    expect(doc?.truncated).toBe(true);
    expect(text!.length).toBeLessThan(8000);
    expect(text).not.toContain('x'.repeat(1000));
  });
  it('does not fetch missing media or turn canvas pixels into text', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    browser.document.body.innerHTML =
      '<img src="https://example.com/image.png"><video src="https://example.com/stream"></video><canvas></canvas>';
    const { doc } = snapshot();
    expect(doc?.resources.map((r) => r.state)).toEqual(['not-loaded', 'not-loaded', 'unsupported']);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
function client(
  options: { old?: boolean; corrupt?: boolean; mutate?: boolean } = {},
): ZendriverClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async call(name, args) {
      calls.push(name);
      if (name === 'browser_frame_list')
        return {
          content: [],
          structuredContent: options.old
            ? { frames: [] }
            : {
                capture_protocol: 'rendered-document-v1',
                build_id: 'trinity-document-v1',
                frames: [
                  {
                    id: 'main',
                    url: 'https://example.com/',
                    parent_id: null,
                    is_main: true,
                    owner_path: null,
                  },
                ],
              },
        };
      if (name !== 'browser_evaluate') throw Error('Unexpected network/action');
      const expression = String(args.expression);
      let value: unknown = browser.window.eval(expression);
      if (value && typeof value === 'object' && 'length' in value) {
        // Fixture origin is jsdom's about:blank; inherit the test HTTP provenance.
        if (options.mutate) browser.document.body.append(browser.document.createElement('p'));
      }
      if (options.corrupt && value && typeof value === 'object' && 'text' in value)
        value = { ...value, text: String(value.text).replace('Mounted', 'Changed') };
      return { content: [], structuredContent: { value } };
    },
  };
}
describe('driver capability, chunks and cancellation', () => {
  it('rejects an older guest before evaluation', async () => {
    const c = client({ old: true });
    await expect(captureRenderedDocuments(c)).rejects.toMatchObject({ code: 'DISABLED' });
    expect(c.calls).toEqual(['browser_frame_list']);
  });
  it('detects corrupt chunk hashes', async () => {
    await expect(captureRenderedDocuments(client({ corrupt: true }))).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    });
  });
  it('detects a mutation without replaying navigation or clicks', async () => {
    const c = client({ mutate: true });
    await expect(captureRenderedDocuments(c)).rejects.toMatchObject({ code: 'STALE_TARGET' });
    expect(c.calls.every((n) => ['browser_frame_list', 'browser_evaluate'].includes(n))).toBe(true);
  });
  it('propagates cancellation before a browser read', async () => {
    const stop = new AbortController();
    stop.abort();
    const c = client();
    await expect(captureRenderedDocuments(c, stop.signal)).rejects.toThrow();
  });
});

function loadHtml(html: string): void {
  const parsed = new browser.window.DOMParser().parseFromString(html, 'text/html');
  browser.document.documentElement.innerHTML = parsed.documentElement.innerHTML;
}
describe('rendered report fidelity', () => {
  it('preserves visible aria-hidden vectors, computed layout, table spans and exported Markdown', async () => {
    loadHtml(
      readFileSync(join(process.cwd(), 'packages/core/test/fixtures/rendered-report.html'), 'utf8'),
    );
    const { doc } = snapshot();
    expect(doc!.resources.map((r) => r.state)).toEqual(['inline', 'inline']);
    expect(
      doc!.nodes.find((n) => n.presentation?.display === 'grid')?.presentation?.[
        'grid-template-columns'
      ],
    ).toBe('160px 24px 160px');
    const html = documentHtml(doc!);
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 8 24"');
    expect(html).toContain('d="M4 0V20M1 17L4 20L7 17"');
    expect(html).toContain('colspan="2"');
    expect(html).not.toContain('aria-hidden');
    // Immutable manifests sort object keys; replay must produce the same HTML bytes.
    expect(
      documentHtml(browserRenderedDocumentSchema.parse(JSON.parse(canonicalBrowserJson(doc)))),
    ).toBe(html);
    const directory = await mkdtemp(join(tmpdir(), 'report-capture-'));
    try {
      const graph = validateDocumentGraph({
        protocol: 'rendered-document-v1',
        buildId: 'trinity-document-v1',
        startedAt: '2026-11-14T00:00:00.000Z',
        finishedAt: '2026-11-14T00:00:00.000Z',
        documents: [doc],
        omittedFrames: 0,
        stability: 'checked-interval',
      });
      const manifest = await persistDocumentGraph(
        graph,
        {
          bindingId: 'binding',
          tabId: 'tab',
          documentRevision: 'rev',
          browserVersion: 'test',
          cliVersion: 'test',
          cliSession: 'test',
        },
        'session',
        'call',
        'capture',
        new LocalBlobStore(directory),
      );
      const summary = documentResult(manifest, 'capture_document', 'call');
      expect(summary.presentationOmissions).toEqual([]);
      expect(summary.resources).toEqual({
        captured: 2,
        unavailable: 0,
      });
      const partial = documentResult(
        {
          ...manifest,
          documents: manifest.documents.map((d) => ({
            ...d,
            exclusions: [...d.exclusions, 'vector-omitted'],
          })),
        },
        'capture_document',
        'call',
      );
      expect(partial.coverage).toBe('partial');
      expect(partial.presentationOmissions).toEqual(['vector-omitted']);
      const exported = documentConversionHtml(manifest);
      const md = await browserHtmlToMarkdown(exported);
      expect(md.text).toContain('<svg');
      expect(md.text).toContain('M4 0V20');
      expect(md.text).toContain('Approved');
      expect(md.text).toContain('https://example.com/source');
      expect(md.warnings).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('preserves block-span grid cells through capture, saved HTML and Markdown conversion', async () => {
    loadHtml(
      '<main><h2>Status</h2><div style="display:grid;grid-template-columns:100px 100px"><span style="display:block">Service</span><span style="display:block">State</span><span style="display:block">Search</span><span style="display:block">Available</span></div></main>',
    );
    const { doc } = snapshot();
    expect(
      doc!.nodes
        .filter((node) => node.tag === 'span')
        .every((node) => node.presentation?.display === 'block'),
    ).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), 'grid-capture-'));
    try {
      const graph = validateDocumentGraph({
        protocol: 'rendered-document-v1',
        buildId: 'trinity-document-v1',
        startedAt: '2026-11-14T00:00:00.000Z',
        finishedAt: '2026-11-14T00:00:00.000Z',
        documents: [doc],
        omittedFrames: 0,
        stability: 'checked-interval',
      });
      const manifest = await persistDocumentGraph(
        graph,
        {
          bindingId: 'binding',
          tabId: 'tab',
          documentRevision: 'rev',
          browserVersion: 'test',
          cliVersion: 'test',
          cliSession: 'test',
        },
        'session',
        'call',
        'capture',
        new LocalBlobStore(directory),
      );
      const html = documentConversionHtml(manifest);
      expect(html).toContain('grid-template-columns:100px 100px');
      const converted = await browserHtmlToMarkdown(html);
      expect(converted.text).not.toContain('ServiceStateSearchAvailable');
      for (const cell of ['Service', 'State', 'Search', 'Available'])
        expect(converted.text).toContain('>' + cell + '</span>');
      expect(converted.warningCodes).toContain('layout-html');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('excludes truly hidden vectors, inspects visible aria-hidden protected controls', () => {
    browser.document.body.innerHTML =
      '<svg style="display:none"><path d="M1 2"/></svg><svg hidden><circle r="3"/></svg>';
    expect(snapshot().doc!.nodes.some((n) => n.tag === 'svg')).toBe(false);
    browser.window.eval(documentReleaseScript(key, false));
    browser.document.body.innerHTML =
      '<div aria-hidden="true"><input type="password" value="secret"></div>';
    expect(snapshot().header.denied).toBe(true);
  });
  it('reports unsupported vector content and never retains active or external references', () => {
    browser.document.body.innerHTML =
      '<svg><path d="M1 2" onclick="steal()" fill="url(https://bad.example/paint)"/><use href="https://bad.example/vector"/><foreignObject><p>excluded</p></foreignObject><script>steal()</script></svg>';
    const { doc, text } = snapshot();
    expect(doc!.resources[0]!.state).toBe('unsupported');
    expect(doc!.exclusions).toContain('vector-omitted');
    expect(text).not.toMatch(/bad.example|steal|excluded|foreignObject/);
  });
  it.each([
    'url(https://bad.example/)',
    'expression(alert(1))',
    'var(--private)',
    'red;display:none',
    'red\\75rl(x)',
    '<style>',
  ])('rejects unsafe presentation: %s', (value) => {
    expect(browserPresentationSchema.safeParse({ color: value }).success).toBe(false);
  });
  it('rejects unadvertised presentation and vector attributes', () => {
    expect(browserPresentationSchema.safeParse({ 'background-image': 'red' }).success).toBe(false);
    for (const attributes of [
      { onclick: 'evil' },
      { href: 'https://bad.example' },
      { fill: 'url(#private)' },
      { d: '<script>' },
    ])
      expect(browserVectorAttributesSchema.safeParse(attributes).success).toBe(false);
  });
  it.skipIf(!process.env['BROWSER_CAPTURE_REFERENCE_HTML'])(
    'compares the supplied full iframe HTML against the serialized graph',
    () => {
      loadHtml(readFileSync(process.env['BROWSER_CAPTURE_REFERENCE_HTML']!, 'utf8'));
      const before = Array.from(browser.document.querySelectorAll('h1,h2,h3,h4,p')).map(
        (n) => n.textContent,
      );
      const vectors = browser.document.querySelectorAll('svg').length;
      const paths = browser.document.querySelectorAll('svg path').length;
      const { doc } = snapshot();
      expect(doc!.truncated).toBe(false);
      const parsed = new browser.window.DOMParser().parseFromString(
        documentHtml(doc!),
        'text/html',
      );
      expect(
        Array.from(parsed.querySelectorAll('h1,h2,h3,h4,p')).map((n) => n.textContent),
      ).toEqual(before);
      expect(parsed.querySelectorAll('svg')).toHaveLength(vectors);
      expect(parsed.querySelectorAll('svg path')).toHaveLength(paths);
      expect(doc!.resources.filter((r) => r.role === 'svg' && r.state === 'inline')).toHaveLength(
        vectors,
      );
    },
  );
});
