import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_LIMITS,
  browserArgumentsSchema,
  browserCaptureSchema,
  browserErrorSchema,
  browserObservationSchema,
  browserResultSchema,
  type BlobStore,
  type BrowserAccessPort,
  type BrowserBinding,
  type BrowserCapture,
  type BrowserObservation,
} from '@trinity-harness/contracts';
import {
  CoreToolRegistry,
  MemorySessionStore,
  createBrowserTool,
  createReadBlobTool,
  createResearchTool,
} from '../src/index.js';
import { FakeSandbox } from '../src/testing/index.js';
import {
  browserArtifactUri,
  browserHash,
  canonicalBrowserJson,
  browserDeliveries,
} from '../src/tools/browser-artifacts.js';
import { PNG } from 'pngjs';
import { toModelMessages } from '../src/loop/to-model-messages.js';
import { resolveBrowserImage } from '../src/tools/browser-artifacts.js';
import { deliver } from '../src/tools/browser.js';
import { resolveBrowserSource } from '../src/tools/browser-evidence.js';
import { answerGrounding } from '../src/loop/answer-grounding.js';
import { CdpAccessError, TrustedCdpBrowserAccess } from '../src/tools/browser-cdp.js';
import { progressGuidance } from '../src/loop/progress-guidance.js';

const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-01-01T00:00:00.000Z' });
const binding: BrowserBinding = {
  bindingId: 'binding',
  tabId: 'tab',
  documentRevision: 'revision',
  cliVersion: '1.0.0',
  browserVersion: 'Chrome-1',
  cliSession: 'owned-session',
};
const surface = {
  context: {
    width: 800,
    height: 600,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
    locale: 'en-US',
    timezone: 'UTC',
  },
  targets: [
    {
      ref: 'r0',
      role: 'button',
      name: 'Read more',
      path: [1, 0],
      disabled: false,
      sensitive: false,
      box: { x: 10, y: 10, width: 100, height: 30 },
    },
    {
      ref: 'r1',
      role: 'textbox',
      name: 'Search',
      path: [1, 1],
      disabled: false,
      sensitive: false,
      box: { x: 10, y: 50, width: 100, height: 30 },
    },
  ],
  truncated: false,
  privacyDenied: false,
};
const capture: BrowserCapture = {
  schemaVersion: 1,
  extractorVersion: 'semantic-v1',
  url: 'https://example.com/article',
  title: '论文',
  publishedAt: null,
  readiness: 'ready',
  representation: 'article',
  scope: 'article',
  exclusions: ['hidden'],
  captureTruncated: false,
  blocks: [
    { id: 'b0', kind: 'heading', sectionId: 'b0', text: '论文标题：Nature “原文” 😀', links: [] },
    {
      id: 'b1',
      kind: 'paragraph',
      sectionId: 'b0',
      text: 'Title：Late-life treatment 查看更多 期刊：Nature.',
      links: [],
    },
  ],
};
function observation(text?: string): BrowserObservation {
  const payload = {
    ...capture,
    blocks: text === undefined ? capture.blocks : [{ ...capture.blocks[0]!, text }],
    observationId: 'observation',
    sessionId: 's',
    bindingId: binding.bindingId,
    tabId: binding.tabId,
    documentRevision: binding.documentRevision,
    cliVersion: binding.cliVersion,
    browserVersion: binding.browserVersion,
    capturedAt: meta().at,
  };
  return { ...payload, hash: browserHash(payload) };
}
function memoryBlobs(): BlobStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put: async (key, bytes, opts) => {
      const uri = `blob://${key}`;
      data.set(uri, bytes);
      return { key: key!, uri, size: bytes.length, mimeType: opts.mimeType };
    },
    get: async (uri) => data.get(uri) ?? null,
    getMeta: async (uri) =>
      data.has(uri)
        ? { key: uri.slice(7), uri, size: data.get(uri)!.length, mimeType: 'application/json' }
        : null,
    delete: async (uri) => {
      data.delete(uri);
    },
  };
}
async function assembly(
  access: BrowserAccessPort | undefined = { authorize: async () => binding },
  page: BrowserCapture = capture,
) {
  const store = new MemorySessionStore();
  const blobs = memoryBlobs();
  const sandbox = new FakeSandbox();
  const calls: string[][] = [];
  sandbox.argvHandler = async (_cmd, args, opts) => {
    expect(opts.maxOutputBytes).toBeLessThanOrEqual(BROWSER_LIMITS.transport);
    calls.push(args);
    const value = args.includes('eval')
      ? {
          result: args.some((a) => a.includes('el.click()'))
            ? { applied: true }
            : args.some((a) => a.includes('requestAnimationFrame'))
              ? 'ready'
              : args.some((a) => a.includes('document.elementFromPoint'))
                ? { allowed: true }
                : args.some((a) => a.includes('privacyDenied'))
                  ? surface
                  : args.some((a) => a.includes('MutationObserver'))
                    ? 'timed_out'
                    : page,
        }
      : args.includes('snapshot')
        ? { snapshot: '- heading "论文"\n- link "source" [ref=e1]' }
        : {};
    return {
      stdout:
        args[0] === '--version'
          ? 'agent-browser 1.0.0'
          : JSON.stringify({ success: true, data: value }),
      stderr: '',
      exitCode: 0,
      outputOverflow: false,
    };
  };
  let observations = 0;
  const registry = new CoreToolRegistry(sandbox);
  registry.register(
    createBrowserTool({
      store,
      blobs,
      access,
      now: () => new Date(meta().at),
      newId: () => (++observations === 1 ? 'observation' : `observation${observations}`),
    }),
  );
  await store.append('s', [
    {
      ...meta(),
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'research' }],
    },
  ]);
  const run = async (id: string, args: unknown, sessionId = 's', permissionGranted = false) => {
    await store.append(sessionId, [
      { ...meta(), type: 'tool/call', name: 'browser', callId: id, args },
    ]);
    const result = await registry.execute(
      { id, name: 'browser', args },
      { sessionId, workspaceRoot: '/ws', permissionGranted },
    );
    await store.append(sessionId, [{ ...meta(), type: 'tool/result', callId: id, ...result }]);
    return result;
  };
  return { store, blobs, sandbox, registry, calls, run };
}

describe('browser web discovery', () => {
  it('searches the user query as encoded navigation and keeps replayable observations and links', async () => {
    const query = '"System one" calibrated decision 中文 & site:example.com';
    const url = `https://www.google.com/search?${new URLSearchParams({ q: query })}`;
    const link = { title: 'Decision model documentation', url: 'https://example.com/decisions' };
    const page: BrowserCapture = {
      ...capture,
      url,
      blocks: [{ ...capture.blocks[0]!, text: 'Observed search snippet', links: [link] }],
    };
    const authorize = vi.fn(async () => binding);
    const { run, calls, store, blobs, sandbox } = await assembly({ authorize }, page);
    const result = await run('discovery', { operation: 'web_search', query });
    expect(result.isError).toBe(false);
    const value = browserResultSchema.parse(result.value);
    expect(calls.find((args) => args.includes('open'))?.slice(-2)).toEqual(['open', url]);
    expect(authorize).toHaveBeenCalledWith('s', 'navigate', url, expect.any(AbortSignal));
    expect(value).toMatchObject({
      operation: 'web_search',
      url,
      saved: false,
      effect: 'applied',
      links: [{ blockId: 'b0', ...link }],
      linksTruncated: false,
    });
    expect(browserDeliveries(await store.load('s'), 's')).toHaveLength(1);
    expect(blobs.data.has(value.artifactUri)).toBe(true);
    sandbox.argvHandler = async () => {
      throw new Error('Replay must not navigate');
    };
    const replay = await run('saved-search', {
      operation: 'read_observation',
      observationId: value.observationId,
      blockIds: ['b0'],
    });
    expect(replay).toMatchObject({ isError: false, value: { saved: true, links: value.links } });
    // A discovered destination is not a captured primary source.
    const notes = createResearchTool(store, blobs);
    const unsupported = await notes.execute(
      {
        action: 'record',
        notes: {
          question: query,
          findings: [
            {
              claim: 'The destination proves the recommendation',
              relation: 'supports',
              sources: [{ url: link.url, quote: 'Observed search snippet' }],
            },
          ],
        },
      },
      { sessionId: 's', callId: 'notes', workspaceRoot: '/ws', sandbox },
    );
    expect(unsupported.isError).toBe(true);
  });
  it.each(['', '   ', 'x'.repeat(201)])(
    'rejects invalid queries before navigation',
    async (query) => {
      const { run, calls } = await assembly();
      expect((await run('invalid-search', { operation: 'web_search', query })).isError).toBe(true);
      expect(calls).toEqual([]);
    },
  );
  it('reports an unavailable channel, not invalid output, when the adapter malfunctions', async () => {
    const { run, sandbox } = await assembly();
    const old = sandbox.argvHandler!;
    sandbox.argvHandler = async (cmd, args, opts) =>
      args.includes('eval')
        ? {
            stdout: JSON.stringify({ success: true, data: { garbage: true } }),
            stderr: '',
            exitCode: 0,
            outputOverflow: false,
          }
        : old(cmd, args, opts);
    const result = await run('broken-channel', { operation: 'web_search', query: 'query' });
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({
      kind: 'browser-error-v1',
      code: 'DRIVER_FAILED',
      recovery: 'conclude',
    });
    const parsed = browserErrorSchema.parse(result.value);
    expect(parsed.message).toContain('browser adapter failed unexpectedly');
    expect(parsed.message).toContain('unavailable');
    expect(parsed.message).not.toContain('garbage');
    expect(parsed.message.length).toBeLessThanOrEqual(500);
  });
  it('recovers transient adapter timeouts without model-level retries', async () => {
    const { run, sandbox } = await assembly();
    const old = sandbox.argvHandler!;
    let failures = 2;
    sandbox.argvHandler = async (cmd, args, opts) =>
      args[0] === '--version' || failures === 0
        ? old(cmd, args, opts)
        : (failures--,
          {
            stdout: '',
            stderr: 'command cancelled or timed out',
            exitCode: 124,
            outputOverflow: false,
          });
    const result = await run('flaky-channel', { operation: 'web_search', query: 'query' });
    expect(result.isError).toBe(false);
  });
  it('fails closed after bounded transient recovery is exhausted', async () => {
    const { run, sandbox } = await assembly();
    let opens = 0;
    sandbox.argvHandler = async (cmd, args) => {
      if (args[0] !== '--version' && args.includes('open')) opens++;
      return args[0] === '--version'
        ? { stdout: 'agent-browser 1.0.0', stderr: '', exitCode: 0, outputOverflow: false }
        : {
            stdout: '',
            stderr: 'command cancelled or timed out',
            exitCode: 124,
            outputOverflow: false,
          };
    };
    const result = await run('down-channel', { operation: 'web_search', query: 'query' });
    expect(result).toMatchObject({
      isError: true,
      value: { kind: 'browser-error-v1', code: 'DRIVER_FAILED', recovery: 'conclude' },
    });
    expect(opens).toBe(3);
  });
  it('does not retry a missing browser CLI binary', async () => {
    const { run, sandbox } = await assembly();
    const old = sandbox.argvHandler!;
    let opens = 0;
    sandbox.argvHandler = async (cmd, args, opts) => {
      if (args[0] !== '--version' && args.includes('open')) opens++;
      return args[0] === '--version'
        ? old(cmd, args, opts)
        : { stdout: '', stderr: 'spawn agent-browser ENOENT', exitCode: 1, outputOverflow: false };
    };
    const result = await run('missing-cli', { operation: 'web_search', query: 'query' });
    expect(result).toMatchObject({
      isError: true,
      value: { kind: 'browser-error-v1', code: 'DRIVER_FAILED', recovery: 'conclude' },
    });
    expect(opens).toBe(1);
  });
  it('checks destination authorization before searching', async () => {
    const { run, calls } = await assembly({
      authorize: async () => {
        throw new Error('denied');
      },
    });
    expect(
      await run('denied-search', { operation: 'web_search', query: 'unfamiliar term' }),
    ).toMatchObject({
      isError: true,
      value: { operation: 'web_search', code: 'NOT_AUTHORIZED', effect: 'none' },
    });
    expect(calls).toEqual([]);
  });
  it('propagates cancellation and never returns evidence after persistence fails', async () => {
    const { registry, calls, run, blobs } = await assembly();
    const signal = AbortSignal.abort();
    expect(
      await registry.execute(
        { id: 'cancelled', name: 'browser', args: { operation: 'web_search', query: 'term' } },
        { sessionId: 's', workspaceRoot: '/ws', signal },
      ),
    ).toMatchObject({ isError: true, value: { code: 'CANCELLED', effect: 'none' } });
    expect(calls).toEqual([]);
    blobs.put = async () => {
      throw new Error('unavailable');
    };
    expect(await run('persist-failure', { operation: 'web_search', query: 'term' })).toMatchObject({
      isError: true,
      value: { code: 'PERSIST_FAILED', effect: 'unknown' },
    });
    expect(blobs.data.size).toBe(0);
  });
  it('bounds observed links while preserving room for text, receipts and continuation', () => {
    const source = observation();
    source.blocks = Array.from({ length: 30 }, (_, i) => ({
      ...capture.blocks[0]!,
      id: `b${i}`,
      text: 'Search result body '.repeat(200),
      links: [{ title: `Result ${i}`, url: `https://example.com/${i}` }],
    }));
    const result = browserResultSchema.parse(
      deliver(
        source,
        { operation: 'web_search', query: 'term' },
        'search',
        BROWSER_LIMITS.overview,
      ),
    );
    expect(result.links).toHaveLength(20);
    expect(result.linksTruncated).toBe(true);
    expect(result.blocks[0]!.text.length).toBeGreaterThan(500);
    expect(result.receipt.length).toBeGreaterThan(0);
    expect(result.continuation).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(BROWSER_LIMITS.overview);
    const scoped = deliver(
      source,
      { operation: 'read_observation', observationId: source.observationId, blockIds: ['b25'] },
      'scoped',
      BROWSER_LIMITS.focused,
    );
    expect(scoped?.links).toEqual([{ blockId: 'b25', ...source.blocks[25]!.links[0]! }]);
  });
});

describe('browser contracts and capture', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com/'])(
    'rejects unsafe URL %s',
    (url) => {
      expect(browserArgumentsSchema.safeParse({ operation: 'navigate', url }).success).toBe(false);
    },
  );
  it('rejects unsupported operations and malformed/oversized capture', () => {
    expect(browserArgumentsSchema.safeParse({ operation: 'eval', script: 'evil()' }).success).toBe(
      false,
    );
    for (const altered of [
      { ...capture, schemaVersion: 2 },
      { ...capture, blocks: [{ ...capture.blocks[0], text: 'x'.repeat(64_001) }] },
    ])
      expect(browserCaptureSchema.safeParse(altered).success).toBe(false);
  });
  it('captures via bounded argv, persists immutable data and exact receipts', async () => {
    const { run, blobs, calls, store } = await assembly();
    const result = await run('capture', { operation: 'get_page_text' });
    expect(result.isError).toBe(false);
    const value = browserResultSchema.parse(result.value);
    expect(value.receipt).toEqual(
      capture.blocks.map((b) => ({ blockId: b.id, start: 0, end: Array.from(b.text).length })),
    );
    expect(value).toMatchObject({ saved: false, captureTruncated: false, outputTruncated: false });
    expect(calls.at(-1)?.slice(0, 5)).toEqual([
      '--session',
      'owned-session',
      '--json',
      '--pin-tab',
      'eval',
    ]);
    const artifact = browserObservationSchema.parse(
      JSON.parse(new TextDecoder().decode(blobs.data.get(value.artifactUri))),
    );
    expect(artifact.hash).toBe(browserHash(artifact));
    expect(browserDeliveries(await store.load('s'), 's')).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(BROWSER_LIMITS.overview);
  });
  it('delivers a dense first navigation and replays its saved pagination and citations', async () => {
    const { run, blobs, sandbox, store } = await assembly();
    const original = sandbox.argvHandler!;
    const text = 'Microsoft Teams：MCP Apps “evidence” 😀 '.repeat(400);
    sandbox.argvHandler = async (command, args, opts) => {
      const response = await original(command, args, opts);
      if (args.includes('eval')) {
        const value = args.some((arg) => arg.includes('privacyDenied'))
          ? {
              ...surface,
              targets: Array.from({ length: 100 }, (_, i) => ({
                ...surface.targets[0]!,
                ref: `r${i}`,
                name: 'Search result '.repeat(10),
                path: [1, i],
              })),
            }
          : { ...capture, blocks: [{ ...capture.blocks[0]!, text }] };
        response.stdout = JSON.stringify({ success: true, data: { result: value } });
      }
      return response;
    };
    const navigation = await run('navigate', { operation: 'navigate', url: capture.url });
    expect(navigation.isError).toBe(false);
    const first = browserResultSchema.parse(navigation.value);
    expect(first.blocks[0]!.text.length).toBeGreaterThan(500);
    expect(first).toMatchObject({ effect: 'applied', outputTruncated: true });
    expect(first.snapshot).toMatchObject({ truncated: true });
    expect(first.snapshot!.targets.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(BROWSER_LIMITS.overview);
    const artifact = browserObservationSchema.parse(
      JSON.parse(new TextDecoder().decode(blobs.data.get(first.artifactUri))),
    );
    expect(artifact.interaction!.targets).toHaveLength(100);
    expect(artifact.blocks[0]!.text).toBe(text);
    expect(artifact.hash).toBe(browserHash(artifact));

    // Rebuild the registry from persisted events and artifacts, without live access.
    const restarted = new CoreToolRegistry(sandbox);
    restarted.register(createBrowserTool({ store, blobs, now: () => new Date(meta().at) }));
    sandbox.argvHandler = async () => {
      throw new Error('Saved replay must not execute the browser');
    };
    const args = {
      operation: 'read_observation' as const,
      observationId: first.observationId,
      cursor: first.continuation!,
    };
    await store.append('s', [
      { ...meta(), type: 'tool/call', name: 'browser', callId: 'resume', args },
    ]);
    const resumed = await restarted.execute(
      { id: 'resume', name: 'browser', args },
      { sessionId: 's', workspaceRoot: '/ws' },
    );
    expect(resumed.isError).toBe(false);
    const second = browserResultSchema.parse(resumed.value);
    expect(second.blocks[0]!.start).toBe(first.blocks[0]!.end);
    expect(second.blocks[0]!.text).toBe(
      Array.from(text).slice(second.blocks[0]!.start, second.blocks[0]!.end).join(''),
    );
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(BROWSER_LIMITS.focused);
    await store.append('s', [{ ...meta(), type: 'tool/result', callId: 'resume', ...resumed }]);
    const range = second.receipt[0]!;
    const source = await resolveBrowserSource(
      { observationId: first.observationId, ...range, end: range.start + 20 },
      await store.load('s'),
      1,
      's',
      blobs,
    );
    expect(source.quote).toBe(
      Array.from(text)
        .slice(range.start, range.start + 20)
        .join(''),
    );
  });
  it('does not expose live operations without a boundary', async () => {
    const { store, blobs, sandbox } = await assembly();
    const registry = new CoreToolRegistry(sandbox);
    registry.register(createBrowserTool({ store, blobs, now: () => new Date(meta().at) }));
    expect(registry.schemas()[0]?.parameters.type).toBe('object');
    expect(JSON.stringify(registry.schemas())).not.toContain('navigate');
    expect(JSON.stringify(registry.schemas())).not.toContain('web_search');
    expect(
      (
        await registry.execute(
          { id: 'search', name: 'browser', args: { operation: 'web_search', query: 'term' } },
          { sessionId: 's', workspaceRoot: '/ws' },
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await registry.execute(
          { id: 'x', name: 'browser', args: { operation: 'navigate', url: capture.url } },
          { sessionId: 's', workspaceRoot: '/ws' },
        )
      ).isError,
    ).toBe(true);
  });
  it('denies missing operation/site authorization before effects', async () => {
    const { run, calls } = await assembly({
      authorize: async () => {
        throw new Error('denied');
      },
    });
    expect(await run('denied', { operation: 'navigate', url: capture.url })).toMatchObject({
      isError: true,
      value: { code: 'NOT_AUTHORIZED', effect: 'none' },
    });
    expect(calls).toHaveLength(0);
  });
  it.each([
    ['CDP_PAGE_UNAVAILABLE', 'PAGE_UNAVAILABLE', 'navigate', 'Chrome network error page'],
    ['CDP_OWNER_DENIED', 'NOT_AUTHORIZED', 'conclude', 'ownership was denied'],
    ['CDP_PROBE_FAILED', 'DRIVER_FAILED', 'conclude', 'could not be inspected'],
    ['CDP_UNSUPPORTED_CLI', 'DISABLED', 'conclude', 'incompatible'],
    ['CDP_DOCUMENT_CHANGED', 'STALE_TARGET', 'reobserve', 'document changed'],
  ])('preserves safe recovery diagnostics for %s', async (cause, code, recovery, message) => {
    const { run, calls } = await assembly({
      authorize: async () => {
        throw new CdpAccessError(cause);
      },
    });
    const result = await run('failure', { operation: 'navigate', url: capture.url });
    expect(result).toMatchObject({
      isError: true,
      value: { code, recovery, effect: 'none', message: expect.stringContaining(message) },
    });
    expect(calls).toHaveLength(0);
  });
  it('does not expose arbitrary authorization exception details', async () => {
    const { run } = await assembly({
      authorize: async () => {
        throw new Error('secret=private-token');
      },
    });
    const result = await run('failure', { operation: 'navigate', url: capture.url });
    expect(result).toMatchObject({
      isError: true,
      value: { code: 'NOT_AUTHORIZED', recovery: 'conclude' },
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it('recovers from a Chrome error page through the full tool and trusted-CDP boundary', async () => {
    const { run, sandbox, store, blobs } = await assembly({
      authorize: (...args) => trusted.authorize(...args),
    });
    let currentUrl = 'chrome-error://chromewebdata/';
    const original = sandbox.argvHandler!;
    sandbox.argvHandler = async (command, args, opts) => {
      const result = await original(command, args, opts);
      const envelope = (value: unknown) => JSON.stringify({ success: true, data: value });
      if (args[0] === '--version') result.stdout = 'agent-browser 0.38.2';
      else if (args.includes('cdp-url'))
        result.stdout = envelope({ cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/test' });
      else if (args.includes('list'))
        result.stdout = envelope({ tabs: [{ active: true, targetId: 'owned-target' }] });
      else if (args.some((a) => a.includes('documentRevision:String(performance.timeOrigin)')))
        result.stdout = envelope({
          url: currentUrl,
          documentRevision: '123_4',
          browserVersion: 'Chrome/151.0.0.0',
        });
      else if (args.includes('open')) currentUrl = args.at(-1)!;
      return result;
    };
    const trusted = new TrustedCdpBrowserAccess({
      endpoint: '9222',
      sandbox,
      store,
      authorizeSession: async (id) => id === 's',
    });
    expect(await run('error-page', { operation: 'get_page_text' })).toMatchObject({
      isError: true,
      value: { code: 'PAGE_UNAVAILABLE', recovery: 'navigate', effect: 'none' },
    });
    expect(blobs.data.size).toBe(0);
    const recovered = await run('recovered', { operation: 'navigate', url: capture.url });
    expect(recovered.isError, JSON.stringify(recovered.value)).toBe(false);
    expect(browserResultSchema.parse(recovered.value)).toMatchObject({
      url: capture.url,
      securityMode: 'trusted-cdp',
      tabId: 'owned-target',
      effect: 'applied',
    });
    expect(blobs.data.size).toBe(1);
    expect(browserDeliveries(await store.load('s'), 's')).toHaveLength(1);
  });
  it('rechecks redirects and reports unknown navigation outcome', async () => {
    let count = 0;
    const { run } = await assembly({
      authorize: async () => {
        if (++count > 1) throw new Error('redirect denied');
        return binding;
      },
    });
    expect(await run('redirect', { operation: 'navigate', url: capture.url })).toMatchObject({
      isError: true,
      value: { code: 'NOT_AUTHORIZED', effect: 'unknown' },
    });
  });
  it('preserves unknown navigation effects when revalidation finds a Chrome error page', async () => {
    let count = 0;
    const { run } = await assembly({
      authorize: async () => {
        if (++count > 1) throw new CdpAccessError('CDP_PAGE_UNAVAILABLE');
        return binding;
      },
    });
    expect(
      await run('failed-navigation', { operation: 'navigate', url: capture.url }),
    ).toMatchObject({
      isError: true,
      value: { code: 'PAGE_UNAVAILABLE', effect: 'unknown', recovery: 'navigate' },
    });
  });
  it('validates accessibility envelope and returns read-only observation', async () => {
    const { run } = await assembly();
    expect(await run('snapshot', { operation: 'read_page', filter: 'interactive' })).toMatchObject({
      isError: false,
      value: { blocks: [{ kind: 'accessibility' }] },
    });
  });
  it.each(['get_page_text', 'read_page'] as const)(
    'rejects a same-URL reload during %s without persisting mixed evidence',
    async (operation) => {
      let count = 0;
      const { run, blobs } = await assembly({
        authorize: async () => ({
          ...binding,
          documentRevision:
            ++count === (operation === 'read_page' ? 3 : 2) ? 'reloaded' : 'revision',
        }),
      });
      expect(await run('reload', { operation })).toMatchObject({
        isError: true,
        value: { code: 'STALE_TARGET' },
      });
      expect(blobs.data.size).toBe(0);
    },
  );
  it.each(['invalid', 'overflow', 'storage', 'version'])(
    'bounds %s failures without leaking output',
    async (kind) => {
      const { run, sandbox, blobs } = await assembly();
      if (kind === 'storage')
        blobs.put = async () => {
          throw new Error('private failure');
        };
      else {
        const old = sandbox.argvHandler!;
        sandbox.argvHandler = async (c, a, o) =>
          a[0] === '--version' && kind !== 'version'
            ? old(c, a, o)
            : {
                stdout: kind === 'version' ? 'wrong version' : 'private malformed output',
                stderr: 'secret',
                exitCode: 0,
                outputOverflow: kind === 'overflow',
              };
      }
      const result = await run('bad', { operation: 'get_page_text' });
      expect(result.isError).toBe(true);
      expect(browserErrorSchema.safeParse(result.value).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
        BROWSER_LIMITS.diagnostic,
      );
      if (kind === 'storage') expect(result).toMatchObject({ value: { code: 'PERSIST_FAILED' } });
    },
  );
  it('cancels before any effects', async () => {
    const { registry, calls } = await assembly();
    expect(
      (
        await registry.execute(
          { id: 'x', name: 'browser', args: { operation: 'get_page_text' } },
          { sessionId: 's', workspaceRoot: '/ws', signal: AbortSignal.abort() },
        )
      ).isError,
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('bounded saved reading and evidence', () => {
  it('canonicalizes sorted object keys and preserves duplicate blocks and punctuation', () => {
    expect(canonicalBrowserJson({ b: 2, a: 1 })).toBe(canonicalBrowserJson({ a: 1, b: 2 }));
    const saved = observation();
    expect(browserHash({ ...saved, title: 'changed' })).not.toBe(saved.hash);
    expect(saved.blocks[0]!.text).toContain('：');
  });
  it('slices large Unicode blocks with exact half-open receipts and pagination', () => {
    const saved = observation('😀论文：'.repeat(5000));
    const first = deliver(
      saved,
      { operation: 'read_observation', observationId: saved.observationId },
      'first',
      2048,
    )!;
    expect(first.outputTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2048);
    expect(first.blocks[0]!.text).toBe(
      Array.from(saved.blocks[0]!.text)
        .slice(first.blocks[0]!.start, first.blocks[0]!.end)
        .join(''),
    );
    const second = deliver(
      saved,
      {
        operation: 'read_observation',
        observationId: saved.observationId,
        cursor: first.continuation!,
      },
      'second',
      2048,
      [first],
    )!;
    expect(second.blocks[0]!.start).toBe(first.blocks[0]!.end);
    expect(browserResultSchema.safeParse(first).success).toBe(true);
  });
  it('keeps pagination inside exact byte boundaries between differently sized block IDs', () => {
    const saved = observation();
    saved.blocks = [
      { ...capture.blocks[0]!, id: 'b0', text: 'First paragraph.' },
      { ...capture.blocks[1]!, id: 'b'.repeat(200), text: '😀'.repeat(100) },
    ];
    for (let limit = 800; limit <= 1600; limit++) {
      const result = deliver(
        saved,
        { operation: 'read_observation', observationId: saved.observationId },
        'read',
        limit,
      );
      expect(result, `limit=${limit}`).not.toBeNull();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(limit);
      expect(browserResultSchema.safeParse(result).success).toBe(true);
      if (result!.outputTruncated) expect(result!.continuation).not.toBeNull();
    }
    expect(deliver(saved, { operation: 'get_page_text', mode: 'article' }, 'tiny', 100)).toBeNull();
  });
  it('restores saved reads without executing CLI and suppresses duplicate deliveries', async () => {
    const { run, calls, store, blobs } = await assembly();
    await run('capture', { operation: 'get_page_text' });
    const effects = calls.length;
    const duplicate = await run('duplicate', {
      operation: 'read_observation',
      observationId: 'observation',
    });
    expect(duplicate).toMatchObject({
      isError: false,
      value: { blocks: [], receipt: [], saved: true },
    });
    expect(calls).toHaveLength(effects);
    await store.append('s', [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'next turn' }],
      },
    ]);
    // A newly constructed registry has no worker-local observation cache.
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(createBrowserTool({ store, blobs, now: () => new Date(meta().at) }));
    const reread = await registry.execute(
      {
        id: 'reread',
        name: 'browser',
        args: { operation: 'search_observation', observationId: 'observation', query: '期刊：' },
      },
      { sessionId: 's', workspaceRoot: '/ws' },
    );
    expect(reread).toMatchObject({
      isError: false,
      value: { saved: true, capturedAt: meta().at, blocks: [{ id: 'b1' }] },
    });
  });
  it('rejects cross-session, fork-copied, missing and corrupt artifacts', async () => {
    const { run, store, blobs } = await assembly();
    await run('capture', { operation: 'get_page_text' });
    await store.append('fork', await store.load('s'));
    for (const session of ['other', 'fork'])
      expect(
        (await run('x', { operation: 'read_observation', observationId: 'observation' }, session))
          .isError,
      ).toBe(true);
    const uri = browserArtifactUri('s', 'observation');
    const original = blobs.data.get(uri)!;
    blobs.data.delete(uri);
    expect(
      (await run('missing', { operation: 'read_observation', observationId: 'observation' }))
        .isError,
    ).toBe(true);
    const corrupt = JSON.parse(new TextDecoder().decode(original));
    corrupt.blocks[0].text = 'changed';
    blobs.data.set(uri, new TextEncoder().encode(JSON.stringify(corrupt)));
    expect(
      (await run('corrupt', { operation: 'read_observation', observationId: 'observation' }))
        .isError,
    ).toBe(true);
  });
  it('resolves exact block quotes and final source provenance without retyping', async () => {
    const { run, store, blobs, registry } = await assembly();
    await run('capture', { operation: 'get_page_text' });
    registry.register(createResearchTool(store, blobs));
    const args = {
      action: 'record',
      notes: {
        question: 'What did the source say?',
        findings: [
          {
            claim: 'The source uses original punctuation.',
            relation: 'context',
            sources: [{ observationId: 'observation', blockId: 'b1' }],
          },
        ],
        openQuestions: [],
        readyToAnswer: true,
      },
    };
    const result = await registry.execute(
      { id: 'notes', name: 'research', args },
      { sessionId: 's', workspaceRoot: '/ws' },
    );
    expect(result).toMatchObject({
      isError: false,
      value: {
        notes: {
          findings: [
            {
              sources: [
                {
                  quote: capture.blocks[1]!.text,
                  url: capture.url,
                  callId: 'capture',
                  evidenceSeq: 3,
                },
              ],
            },
          ],
        },
      },
    });
    await store.append('s', [
      { ...meta(), type: 'tool/call', callId: 'notes', name: 'research', args },
      { ...meta(), type: 'tool/result', callId: 'notes', ...result },
    ]);
    expect(await answerGrounding(await store.load('s'), 1, 's', blobs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'web_source',
          observationId: 'observation',
          callId: 'capture',
          evidenceSeq: 3,
        }),
        expect.objectContaining({
          kind: 'research_claim',
          sourceUrls: [capture.url],
          detail: capture.blocks[1]!.text,
        }),
      ]),
    );
  });
  it('rejects unseen ranges, previous-turn references and uncommitted orphan blobs', async () => {
    const { store, blobs, run } = await assembly();
    const saved = observation('😀'.repeat(2000));
    await blobs.put('browser/s/observation.json', new TextEncoder().encode(JSON.stringify(saved)), {
      mimeType: 'application/json',
    });
    const reference = { observationId: 'observation', blockId: 'b0', start: 1900, end: 1910 };
    await expect(
      resolveBrowserSource(reference, await store.load('s'), 1, 's', blobs),
    ).rejects.toThrow();
    const partial = deliver(
      saved,
      { operation: 'get_page_text', mode: 'article' },
      'partial',
      1500,
    )!;
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        name: 'browser',
        callId: 'partial',
        args: { operation: 'get_page_text' },
      },
      { ...meta(), type: 'tool/result', callId: 'partial', isError: false, value: partial },
    ]);
    await expect(
      resolveBrowserSource(reference, await store.load('s'), 1, 's', blobs),
    ).rejects.toThrow('not exposed');
    const resolved = await resolveBrowserSource(
      { ...reference, start: 1, end: 3 },
      await store.load('s'),
      1,
      's',
      blobs,
    );
    expect(resolved.quote).toBe('😀😀');
    await store.append('s', [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'new' }],
      },
    ]);
    await expect(
      resolveBrowserSource(
        { ...reference, start: 1, end: 3 },
        await store.load('s'),
        4,
        's',
        blobs,
      ),
    ).rejects.toThrow();
    expect(
      (
        await run('reread', {
          operation: 'read_observation',
          observationId: 'observation',
          cursor: { blockId: 'b0', offset: 1900 },
        })
      ).isError,
    ).toBe(false);
    expect(
      (await resolveBrowserSource(reference, await store.load('s'), 4, 's', blobs)).quote,
    ).toBe('😀'.repeat(10));
  });
  it('paginates saved evidence beyond 64 KiB across adapter restarts', async () => {
    const { store, blobs, registry, run } = await assembly();
    const text = '😀文'.repeat(20000);
    const saved = observation(text);
    await blobs.put('browser/s/observation.json', new TextEncoder().encode(JSON.stringify(saved)), {
      mimeType: 'application/json',
    });
    const first = deliver(
      saved,
      { operation: 'read_observation', observationId: 'observation' },
      'seed',
      BROWSER_LIMITS.overview,
    )!;
    await store.append('s', [
      { ...meta(), type: 'tool/call', name: 'browser', callId: 'seed', args: {} },
      { ...meta(), type: 'tool/result', callId: 'seed', isError: false, value: first },
    ]);
    let cursor = first.continuation;
    let received = first.blocks.map((block) => block.text).join('');
    let bytes = Buffer.byteLength(JSON.stringify(first));
    for (let index = 0; index < 50 && cursor; index += 1) {
      registry.register(createBrowserTool({ store, blobs, now: () => new Date(meta().at) }));
      const result = await run(`page${index}`, {
        operation: 'read_observation',
        observationId: 'observation',
        cursor,
      });
      expect(result.isError).toBe(false);
      const value = browserResultSchema.parse(result.value);
      const size = Buffer.byteLength(JSON.stringify(value));
      expect(size).toBeLessThanOrEqual(BROWSER_LIMITS.focused);
      bytes += size;
      received += value.blocks.map((block) => block.text).join('');
      cursor = value.continuation;
    }
    expect(cursor).toBeNull();
    expect(received).toBe(text);
    expect(bytes).toBeGreaterThan(128 * 1024);
    expect(
      JSON.parse(new TextDecoder().decode(blobs.data.get('blob://browser/s/observation.json'))),
    ).toEqual(saved);
  });
  it('blocks browser artifacts through generic blob retrieval, including traversal aliases', async () => {
    const { registry } = await assembly();
    registry.register(createReadBlobTool(memoryBlobs()));
    for (const uri of [
      'blob://browser/s/observation.json',
      'blob://other/../browser/s/observation.json',
      'blob://%62rowser/s/observation.json',
    ])
      expect(
        (
          await registry.execute(
            { id: 'blob', name: 'read_blob', args: { uri } },
            { sessionId: 's', workspaceRoot: '/ws' },
          )
        ).isError,
      ).toBe(true);
  });
});

it('bounds malformed argument diagnostics without echoing model keys', async () => {
  const { registry } = await assembly();
  const result = await registry.execute(
    {
      id: 'malformed',
      name: 'browser',
      args: { operation: 'get_page_text', ['secret'.repeat(10000)]: 'value' },
    },
    { sessionId: 's', workspaceRoot: '/ws' },
  );
  expect(result).toMatchObject({
    isError: true,
    value: { code: 'INVALID_ARGUMENTS', effect: 'none' },
  });
  expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
    BROWSER_LIMITS.diagnostic,
  );
  expect(JSON.stringify(result.value)).not.toContain('secret');
});

it('continues live reading beyond the former cumulative delivery ceilings', async () => {
  const { run, blobs } = await assembly();
  let bytes = 0;
  for (let index = 0; index < 80; index += 1) {
    const result = await run(`capture${index}`, { operation: 'get_page_text' });
    expect(result.isError).toBe(false);
    const size = Buffer.byteLength(JSON.stringify(result.value));
    expect(size).toBeLessThanOrEqual(BROWSER_LIMITS.overview);
    bytes += size;
  }
  expect(bytes).toBeGreaterThan(64 * 1024);
  expect(blobs.data.size).toBe(80);
});

it('reports navigation persistence failure as an unknown effect, without retrying it', async () => {
  const { run, blobs, calls } = await assembly();
  blobs.put = async () => {
    throw new Error('storage failed');
  };
  expect(await run('navigate', { operation: 'navigate', url: capture.url })).toMatchObject({
    isError: true,
    value: { code: 'PERSIST_FAILED', effect: 'unknown' },
  });
  expect(calls.filter((args) => args.includes('open'))).toHaveLength(1);
});

it('rejects invalid saved ranges, unknown blocks, and forbidden script arguments', async () => {
  const { run } = await assembly();
  await run('capture', { operation: 'get_page_text' });
  for (const [i, args] of [
    {
      operation: 'read_observation',
      observationId: 'observation',
      cursor: { blockId: 'b0', offset: 10000 },
    },
    { operation: 'read_observation', observationId: 'observation', blockIds: ['missing'] },
    { operation: 'get_page_text', script: 'document.cookie' },
  ].entries())
    expect((await run(`invalid-${i}`, args)).isError).toBe(true);
});

it('does not return unrelated suffixes when literal search hits were already exposed', () => {
  const saved = observation('prefix '.repeat(80) + 'needle' + ' suffix'.repeat(100));
  const args = {
    operation: 'search_observation' as const,
    observationId: saved.observationId,
    query: 'needle',
  };
  const first = deliver(saved, args, 'first', 8192)!;
  expect(first.blocks[0]!.text).toContain('needle');
  const duplicate = deliver(saved, args, 'second', 8192, [first])!;
  expect(duplicate.blocks).toEqual([]);
  expect(duplicate.duplicateSuppressed).toBe(true);
});

it('does not recover notes whose referenced artifact has become unavailable', async () => {
  const { run, registry, store, blobs } = await assembly();
  await run('capture', { operation: 'get_page_text' });
  registry.register(createResearchTool(store, blobs));
  const args = {
    action: 'record',
    notes: {
      question: 'question',
      findings: [
        {
          claim: 'claim',
          relation: 'context',
          sources: [{ observationId: 'observation', blockId: 'b0' }],
        },
      ],
      openQuestions: [],
      readyToAnswer: true,
    },
  };
  const result = await registry.execute(
    { id: 'notes', name: 'research', args },
    { sessionId: 's', workspaceRoot: '/ws' },
  );
  expect(result.isError).toBe(false);
  await store.append('s', [
    { ...meta(), type: 'tool/call', name: 'research', callId: 'notes', args },
    { ...meta(), type: 'tool/result', callId: 'notes', ...result },
  ]);
  blobs.data.delete(browserArtifactUri('s', 'observation'));
  expect(
    await registry.execute(
      { id: 'status', name: 'research', args: { action: 'status' } },
      { sessionId: 's', workspaceRoot: '/ws' },
    ),
  ).toMatchObject({ isError: true, value: { code: 'RESEARCH_SOURCE_MISMATCH' } });
});

describe('URL/quote references to typed browser evidence', () => {
  const args = (source: { url: string; quote: string; callId?: string }) => ({
    action: 'record',
    notes: {
      question: 'What does the source establish?',
      findings: [{ claim: 'Observed passage', relation: 'context', sources: [source] }],
      openQuestions: [],
      readyToAnswer: true,
    },
  });
  const ctx = { sessionId: 's', workspaceRoot: '/ws' };

  it.each([undefined, 'capture'])(
    'resolves Unicode and whitespace with callId=%s and replays provenance',
    async (callId) => {
      const { run, registry, store, blobs } = await assembly();
      await run('capture', { operation: 'get_page_text' });
      registry.register(createResearchTool(store, blobs));
      const input = args({ url: capture.url, quote: 'Nature\n“原文” 😀', callId });
      const result = await registry.execute({ id: 'notes', name: 'research', args: input }, ctx);
      expect(result).toMatchObject({
        isError: false,
        value: {
          notes: {
            findings: [
              {
                sources: [
                  {
                    observationId: 'observation',
                    blockId: 'b0',
                    start: Array.from(capture.blocks[0]!.text.split('Nature')[0]!).length,
                    end: Array.from(capture.blocks[0]!.text).length,
                    quote: 'Nature “原文” 😀',
                    url: capture.url,
                    callId: 'capture',
                    evidenceSeq: 3,
                  },
                ],
              },
            ],
          },
        },
      });
      await store.append('s', [
        { ...meta(), type: 'tool/call', name: 'research', callId: 'notes', args: input },
        { ...meta(), type: 'tool/result', callId: 'notes', ...result },
      ]);
      const restored = new MemorySessionStore();
      await restored.append('s', JSON.parse(JSON.stringify(await store.load('s'))));
      registry.register(createResearchTool(restored, blobs));
      expect(
        await registry.execute({ id: 'status', name: 'research', args: { action: 'status' } }, ctx),
      ).toEqual(result);
    },
  );

  it.each([
    'changed punctuation',
    'wrong URL',
    'wrong call',
    'failed read',
    'unrelated tool',
    'other session',
    'previous turn',
    'missing artifact',
    'corrupt artifact',
  ])('rejects %s', async (failure) => {
    const { run, registry, store, blobs } = await assembly();
    await run('capture', { operation: 'get_page_text' });
    const events = await store.load('s');
    const input = args({ url: capture.url, quote: capture.blocks[0]!.text, callId: 'capture' });
    const source = input.notes.findings[0]!.sources[0]!;
    const call = events[1]!;
    const result = events[2]!;
    if (call.type !== 'tool/call' || result.type !== 'tool/result') throw new Error('Missing pair');
    if (failure === 'changed punctuation') source.quote = source.quote.replace('：', ':');
    if (failure === 'wrong URL') source.url = 'https://example.com/other';
    if (failure === 'wrong call') source.callId = 'other';
    if (failure === 'failed read') result.isError = true;
    if (failure === 'unrelated tool') call.name = 'other';
    if (failure === 'other session')
      result.value = { ...(result.value as object), sessionId: 'other' };
    if (failure === 'previous turn')
      events.push({
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'next' }],
      });
    const uri = browserArtifactUri('s', 'observation');
    if (failure === 'missing artifact') blobs.data.delete(uri);
    if (failure === 'corrupt artifact') blobs.data.set(uri, new TextEncoder().encode('{}'));
    const restored = new MemorySessionStore();
    await restored.append('s', events);
    registry.register(createResearchTool(restored, blobs));
    expect(
      await registry.execute({ id: 'notes', name: 'research', args: input }, ctx),
    ).toMatchObject({ isError: true, value: { code: 'RESEARCH_SOURCE_MISMATCH' } });
  });

  it('does not promote unread artifact text into citeable evidence or require pagination', async () => {
    const { store, registry, blobs } = await assembly();
    const saved = observation('Visible text. '.repeat(1000) + 'Undelivered finding.');
    await blobs.put('browser/s/observation.json', new TextEncoder().encode(JSON.stringify(saved)), {
      mimeType: 'application/json',
    });
    const partial = deliver(
      saved,
      { operation: 'get_page_text', mode: 'article' },
      'partial',
      1500,
    )!;
    expect(partial.outputTruncated).toBe(true);
    expect(partial.continuation).not.toBeNull();
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        name: 'browser',
        callId: 'partial',
        args: { operation: 'get_page_text' },
      },
      { ...meta(), type: 'tool/result', callId: 'partial', isError: false, value: partial },
    ]);
    registry.register(createResearchTool(store, blobs));
    expect(
      await registry.execute(
        {
          id: 'notes',
          name: 'research',
          args: args({ url: saved.url, quote: 'Undelivered finding.' }),
        },
        ctx,
      ),
    ).toMatchObject({ isError: true });
    expect(
      await registry.execute(
        { id: 'visible', name: 'research', args: args({ url: saved.url, quote: 'Visible text.' }) },
        ctx,
      ),
    ).toMatchObject({ isError: false });
    expect(progressGuidance(await store.load('s'), 1, 1, Infinity, true)).toBeNull();
  });

  it.each(['adjacent', 'gap', 'different call', 'altered receipt'])(
    'matches only contiguous authorized slices: %s',
    async (scenario) => {
      const { store, registry, blobs } = await assembly();
      const saved = observation('😀 before alpha\n beta after');
      await blobs.put(
        'browser/s/observation.json',
        new TextEncoder().encode(JSON.stringify(saved)),
        {
          mimeType: 'application/json',
        },
      );
      const points = Array.from(saved.blocks[0]!.text);
      const split = points.indexOf('\n');
      for (const [index, start, end] of [
        [0, 0, split],
        [1, scenario === 'gap' ? split + 2 : split, points.length],
      ] as const) {
        const callId = `slice${index}`;
        const result = deliver(
          saved,
          { operation: 'get_page_text', mode: 'article' },
          callId,
          8192,
        )!;
        result.blocks = [
          {
            ...result.blocks[0]!,
            start,
            end,
            text: points.slice(start, end).join(''),
          },
        ];
        result.receipt = [{ blockId: 'b0', start, end }];
        if (scenario === 'altered receipt' && index === 1)
          result.blocks[0]!.text = result.blocks[0]!.text.replace('beta', 'fake');
        await store.append('s', [
          {
            ...meta(),
            type: 'tool/call',
            name: 'browser',
            callId,
            args: { operation: 'get_page_text' },
          },
          { ...meta(), type: 'tool/result', callId, isError: false, value: result },
        ]);
      }
      registry.register(createResearchTool(store, blobs));
      const input = args({
        url: saved.url,
        quote: 'alpha beta',
        ...(scenario === 'different call' ? { callId: 'slice0' } : {}),
      });
      expect(
        await registry.execute({ id: 'notes', name: 'research', args: input }, ctx),
      ).toMatchObject({ isError: scenario !== 'adjacent' });
    },
  );

  it('does not join different blocks or interpret quote text as a regular expression', async () => {
    const { run, registry, store, blobs } = await assembly();
    await run('capture', { operation: 'get_page_text' });
    registry.register(createResearchTool(store, blobs));
    for (const quote of [capture.blocks.map((block) => block.text).join(' '), 'Nature.*😀']) {
      expect(
        await registry.execute(
          { id: 'notes', name: 'research', args: args({ url: capture.url, quote }) },
          ctx,
        ),
      ).toMatchObject({ isError: true, value: { reason: 'quote_mismatch' } });
    }
  });

  it.each([
    { source: { blockId: 'missing' }, reason: 'UNKNOWN_BLOCK' },
    { source: { blockId: 'b0', start: 3, end: 9000 }, reason: 'INVALID_RANGE' },
    { source: { blockId: 'b0', start: 0, end: 700 }, reason: 'RANGE_TOO_LARGE' },
    { source: { blockId: 'b0', start: 4000, end: 4010 }, reason: 'RANGE_NOT_EXPOSED' },
  ])(
    'identifies citation failures as $reason with their source path',
    async ({ source, reason }) => {
      const { store, registry, blobs } = await assembly();
      const saved = observation('text '.repeat(1000));
      await blobs.put(
        'browser/s/observation.json',
        new TextEncoder().encode(JSON.stringify(saved)),
        { mimeType: 'application/json' },
      );
      const partial = deliver(
        saved,
        { operation: 'get_page_text', mode: 'article' },
        'partial',
        1500,
      )!;
      await store.append('s', [
        {
          ...meta(),
          type: 'tool/call',
          name: 'browser',
          callId: 'partial',
          args: { operation: 'get_page_text' },
        },
        { ...meta(), type: 'tool/result', callId: 'partial', isError: false, value: partial },
      ]);
      registry.register(createResearchTool(store, blobs));
      const input = args({ url: '', quote: '' });
      const ref = {
        ...input,
        notes: {
          ...input.notes,
          findings: [
            { ...input.notes.findings[0], sources: [{ observationId: 'observation', ...source }] },
          ],
        },
      };
      expect(
        await registry.execute({ id: 'notes', name: 'research', args: ref }, ctx),
      ).toMatchObject({ isError: true, value: { reason, path: 'notes.findings[0].sources[0]' } });
    },
  );
});

describe('scoped browser interactions and screenshots', () => {
  it('requires per-call authorization before effects and applies only an exposed ref', async () => {
    const { run, calls } = await assembly();
    const first = browserResultSchema.parse((await run('page', { operation: 'read_page' })).value);
    expect(first.snapshot?.targets.map((t) => t.ref)).toContain('r0');
    const before = calls.length;
    expect(
      await run('denied', { operation: 'click', snapshotId: first.observationId, ref: 'r0' }),
    ).toMatchObject({ isError: true, value: { code: 'NOT_AUTHORIZED', effect: 'none' } });
    expect(calls).toHaveLength(before);
    const fresh = browserResultSchema.parse((await run('fresh', { operation: 'read_page' })).value);
    const applied = await run(
      'click',
      { operation: 'click', snapshotId: fresh.observationId, ref: 'r0' },
      's',
      true,
    );
    expect(applied).toMatchObject({
      isError: false,
      value: { effect: 'applied', snapshot: { snapshotId: 'observation3' } },
    });
    expect(
      calls.some((a) => a.includes('click') && a.includes('html > :nth-child(2) > :nth-child(1)')),
    ).toBe(true);
    expect(
      await run(
        'reuse',
        { operation: 'click', snapshotId: fresh.observationId, ref: 'r0' },
        's',
        true,
      ),
    ).toMatchObject({ isError: true, value: { code: 'STALE_TARGET' } });
  });
  it('activates native controls using only the checked fixed DOM operation', async () => {
    const { run, calls, sandbox } = await assembly();
    const old = sandbox.argvHandler!;
    sandbox.argvHandler = async (c, a, o) =>
      a.some((v) => v.includes('privacyDenied'))
        ? {
            stdout: JSON.stringify({
              success: true,
              data: {
                ...surface,
                targets: surface.targets.map((t) => ({ ...t, activation: 'dom' })),
              },
            }),
            stderr: '',
            exitCode: 0,
            outputOverflow: false,
          }
        : old(c, a, o);
    const first = browserResultSchema.parse((await run('page', { operation: 'read_page' })).value);
    expect(
      await run(
        'activate',
        { operation: 'click', snapshotId: first.observationId, ref: 'r0' },
        's',
        true,
      ),
    ).toMatchObject({ isError: false, value: { effect: 'applied' } });
    const activation = calls.find((a) => a.some((v) => v.includes('el.click()')));
    expect(activation?.at(-1)).toContain('target occluded');
    expect(activation?.at(-1)).toContain('html > :nth-child(2) > :nth-child(1)');
    expect(calls.some((a) => a.includes('click') || a.includes('press'))).toBe(false);
  });
  it.each(['scroll', 'target', 'viewport', 'disabled', 'sensitive'] as const)(
    'rejects changed %s before an action',
    async (change) => {
      const { run, calls, sandbox } = await assembly();
      const first = browserResultSchema.parse(
        (await run('page', { operation: 'read_page' })).value,
      );
      const old = sandbox.argvHandler!;
      sandbox.argvHandler = async (c, a, o) =>
        a.some((v) => v.includes('privacyDenied'))
          ? {
              stdout: JSON.stringify({
                success: true,
                data: {
                  ...surface,
                  context: {
                    ...surface.context,
                    ...(change === 'scroll'
                      ? { scrollY: 100 }
                      : change === 'viewport'
                        ? { width: 900 }
                        : {}),
                  },
                  targets: surface.targets.map((t) => ({
                    ...t,
                    ...(change === 'target'
                      ? { name: 'Replaced' }
                      : change === 'disabled'
                        ? { disabled: true }
                        : change === 'sensitive'
                          ? { sensitive: true }
                          : {}),
                  })),
                },
              }),
              stderr: '',
              exitCode: 0,
              outputOverflow: false,
            }
          : old(c, a, o);
      const before = calls.filter((a) => a.includes('click')).length;
      expect(
        await run(
          'bad',
          { operation: 'click', snapshotId: first.observationId, ref: 'r0' },
          's',
          true,
        ),
      ).toMatchObject({ isError: true, value: { code: 'STALE_TARGET', effect: 'none' } });
      expect(calls.filter((a) => a.includes('click'))).toHaveLength(before);
    },
  );
  it('focuses a validated field before key input, and bounds fill/scroll arguments', async () => {
    const { run, calls } = await assembly();
    const first = browserResultSchema.parse((await run('page', { operation: 'read_page' })).value);
    const second = browserResultSchema.parse(
      (
        await run(
          'fill',
          { operation: 'fill', snapshotId: first.observationId, ref: 'r1', text: 'a; $(secret)' },
          's',
          true,
        )
      ).value,
    );
    expect(calls.find((a) => a.includes('fill'))?.at(-1)).toBe('a; $(secret)');
    const third = browserResultSchema.parse(
      (
        await run(
          'key',
          { operation: 'key', snapshotId: second.observationId, ref: 'r1', key: 'Enter' },
          's',
          true,
        )
      ).value,
    );
    expect(calls.slice(-6).some((a) => a.includes('press'))).toBe(true);
    expect(
      await run(
        'scroll',
        { operation: 'scroll', snapshotId: third.observationId, direction: 'down', pixels: 500 },
        's',
        true,
      ),
    ).toMatchObject({ isError: false });
    expect(
      browserArgumentsSchema.safeParse({
        operation: 'fill',
        snapshotId: 's',
        ref: 'r',
        text: 'x'.repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      browserArgumentsSchema.safeParse({
        operation: 'scroll',
        snapshotId: 's',
        direction: 'down',
        pixels: 10000,
      }).success,
    ).toBe(false);
  });
  it('reports unknown effects when a driver fails and invalidates prior targets', async () => {
    const { run, sandbox } = await assembly();
    const first = browserResultSchema.parse((await run('page', { operation: 'read_page' })).value);
    const old = sandbox.argvHandler!;
    sandbox.argvHandler = async (c, a, o) =>
      a.includes('click')
        ? { stdout: '', stderr: 'private error', exitCode: 1, outputOverflow: false }
        : old(c, a, o);
    expect(
      await run(
        'failed',
        { operation: 'click', snapshotId: first.observationId, ref: 'r0' },
        's',
        true,
      ),
    ).toMatchObject({ isError: true, value: { effect: 'unknown', code: 'DRIVER_FAILED' } });
    expect(
      await run(
        'retry',
        { operation: 'click', snapshotId: first.observationId, ref: 'r0' },
        's',
        true,
      ),
    ).toMatchObject({ isError: true, value: { code: 'STALE_TARGET' } });
  });
  it('scopes a read using a delivered target without accepting model selectors', async () => {
    const { run, calls } = await assembly();
    const first = browserResultSchema.parse(
      (await run('page', { operation: 'read_page', filter: 'all' })).value,
    );
    expect(
      await run('scope', {
        operation: 'get_page_text',
        scope: { snapshotId: first.observationId, ref: 'r0' },
      }),
    ).toMatchObject({ isError: false, value: { scope: 'snapshot-subtree' } });
    expect(
      calls
        .filter((a) => a.includes('eval'))
        .some((a) => a.some((v) => v.includes('const scopePath = [1,0]'))),
    ).toBe(true);
  });
  it('persists readiness timeouts with usable partial evidence', async () => {
    const { run } = await assembly();
    expect(
      await run('navigate', {
        operation: 'navigate',
        url: capture.url,
        readiness: { text: 'Not yet ready', timeoutMs: 100 },
      }),
    ).toMatchObject({
      isError: false,
      value: {
        readiness: 'timed_out',
        readinessCondition: { text: 'Not yet ready', timeoutMs: 100 },
      },
    });
  });
  it('captures bounded cropped images, replays multimodal receipts and rejects corrupt/cross-session bytes', async () => {
    const { run, sandbox, blobs, store } = await assembly();
    const png = PNG.sync.write(new PNG({ width: 800, height: 600 }));
    const old = sandbox.argvHandler!;
    sandbox.argvHandler = async (c, a, o) => {
      const i = a.indexOf('screenshot');
      if (i >= 0) sandbox.binaryFiles.set(a[i + 1]!, png);
      return old(c, a, o);
    };
    const result = browserResultSchema.parse(
      (
        await run('shot', {
          operation: 'screenshot',
          crop: { x: 5, y: 5, width: 200, height: 100 },
        })
      ).value,
    );
    expect(result.image).toMatchObject({ width: 200, height: 100, crop: { x: 5, y: 5 }, scale: 1 });
    expect(result.receipt).toEqual([]);
    expect(sandbox.binaryFiles.size).toBe(0);
    const events = await store.load('s');
    expect(toModelMessages(events).at(-1)?.blocks).toEqual([
      { kind: 'image', uri: result.image!.uri, mimeType: 'image/png' },
    ]);
    expect(await resolveBrowserImage(blobs, events, 's', result.image!.uri)).toBeDefined();
    await expect(resolveBrowserImage(blobs, events, 'other', result.image!.uri)).rejects.toThrow(
      'authorized',
    );
    const clicked = await run(
      'coordinate',
      { operation: 'click', snapshotId: result.observationId, point: { x: 15, y: 15 } },
      's',
      true,
    );
    expect(clicked.isError).toBe(false);
    blobs.data.get(result.image!.uri)![0] = 0;
    await expect(resolveBrowserImage(blobs, events, 's', result.image!.uri)).rejects.toThrow(
      'integrity',
    );
  });
  it('marks delayed paint as partial visual evidence and refuses coordinate input', async () => {
    const { run, sandbox } = await assembly();
    const png = PNG.sync.write(new PNG({ width: 800, height: 600 }));
    const old = sandbox.argvHandler!;
    sandbox.argvHandler = async (c, a, o) => {
      const i = a.indexOf('screenshot');
      if (i >= 0) sandbox.binaryFiles.set(a[i + 1]!, png);
      return a.some((v) => v.includes('requestAnimationFrame'))
        ? {
            stdout: JSON.stringify({ success: true, data: { result: 'timed_out' } }),
            stderr: '',
            exitCode: 0,
            outputOverflow: false,
          }
        : old(c, a, o);
    };
    const result = browserResultSchema.parse(
      (await run('shot', { operation: 'screenshot' })).value,
    );
    expect(result.readiness).toBe('partial');
    expect(result.exclusions.join(' ')).toContain('pixels may lag the DOM');
    expect(result.image).toBeDefined();
    expect(
      await run(
        'coordinate',
        { operation: 'click', snapshotId: result.observationId, point: { x: 10, y: 10 } },
        's',
        true,
      ),
    ).toMatchObject({ isError: true, value: { code: 'STALE_TARGET', effect: 'none' } });
  });
  it('reattaches original screenshot pixels on a later turn through a saved read', async () => {
    const { run, sandbox, store, blobs, calls } = await assembly();
    const png = PNG.sync.write(new PNG({ width: 800, height: 600 }));
    const old = sandbox.argvHandler!;
    sandbox.argvHandler = async (command, args, options) => {
      const index = args.indexOf('screenshot');
      if (index >= 0) sandbox.binaryFiles.set(args[index + 1]!, png);
      return old(command, args, options);
    };
    const captured = browserResultSchema.parse(
      (await run('shot', { operation: 'screenshot' })).value,
    );
    await store.append('s', [
      { ...meta(), type: 'turn/end', reason: 'completed' },
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Inspect the earlier screenshot' }],
      },
    ]);
    await expect(
      resolveBrowserImage(blobs, await store.load('s'), 's', captured.image!.uri),
    ).rejects.toThrow();
    const before = calls.length;
    const recalled = browserResultSchema.parse(
      (
        await run('recall', {
          operation: 'read_observation',
          observationId: captured.observationId,
        })
      ).value,
    );
    expect(calls).toHaveLength(before);
    expect(recalled.saved).toBe(true);
    expect(recalled.capturedAt).toBe(captured.capturedAt);
    expect(recalled.image).toEqual(captured.image);
    const events = await store.load('s');
    expect(await resolveBrowserImage(blobs, events, 's', captured.image!.uri)).toEqual(png);
    const messages = toModelMessages(events);
    expect(messages.find((message) => message.toolCallId === 'recall')?.blocks).toEqual([
      { kind: 'image', uri: captured.image!.uri, mimeType: 'image/png' },
    ]);
  });
  it('retains screenshots beyond the former cumulative count and byte ceilings', async () => {
    const { run, sandbox } = await assembly();
    const image = new PNG({ width: 800, height: 600 });
    let noise = 1;
    for (let index = 0; index < image.data.length; index += 1) {
      noise ^= noise << 13;
      noise ^= noise >>> 17;
      noise ^= noise << 5;
      image.data[index] = noise & 255;
    }
    const png = PNG.sync.write(image);
    const old = sandbox.argvHandler!;
    let captures = 0;
    sandbox.argvHandler = async (c, a, o) => {
      const i = a.indexOf('screenshot');
      if (i >= 0) {
        captures++;
        sandbox.binaryFiles.set(a[i + 1]!, png);
      }
      return old(c, a, o);
    };
    let bytes = 0;
    for (let i = 0; i < 6; i++) {
      const result = await run('shot' + i, { operation: 'screenshot' });
      expect(result.isError).toBe(false);
      const image = browserResultSchema.parse(result.value).image!;
      expect(image.bytes).toBeLessThanOrEqual(BROWSER_LIMITS.image);
      bytes += image.bytes;
    }
    expect(captures).toBe(6);
    expect(bytes).toBeGreaterThan(6 * 1024 * 1024);
  });
  it('refuses sensitive capture and image limits without exposing private paths', async () => {
    const { run, sandbox } = await assembly();
    const old = sandbox.argvHandler!;
    sandbox.argvHandler = async (c, a, o) =>
      a.some((v) => v.includes('privacyDenied'))
        ? {
            stdout: JSON.stringify({ success: true, data: { ...surface, privacyDenied: true } }),
            stderr: '',
            exitCode: 0,
            outputOverflow: false,
          }
        : old(c, a, o);
    expect(await run('private', { operation: 'screenshot' })).toMatchObject({
      isError: true,
      value: { code: 'PRIVACY_DENIED' },
    });
    expect(sandbox.binaryFiles.size).toBe(0);
  });
});

it('keeps exact heading selection distinct from section and cursor reads', () => {
  const saved = observation();
  const exact = deliver(
    saved,
    {
      operation: 'read_observation',
      observationId: saved.observationId,
      blockIds: ['b0'],
    },
    'heading',
    8192,
  )!;
  expect(exact.blocks.map((block) => block.id)).toEqual(['b0']);
  const section = deliver(
    saved,
    {
      operation: 'read_observation',
      observationId: saved.observationId,
      sectionId: 'b0',
    },
    'section',
    8192,
  )!;
  expect(section.blocks.map((block) => block.id)).toEqual(['b0', 'b1']);
  const cursor = deliver(
    saved,
    {
      operation: 'read_observation',
      observationId: saved.observationId,
      cursor: { blockId: 'b0', offset: 0 },
    },
    'cursor',
    8192,
  )!;
  expect(cursor.blocks.map((block) => block.id)).toEqual(['b0', 'b1']);
  expect(section.receipt.map((range) => range.blockId)).toEqual(['b0', 'b1']);
});
