import { describe, expect, it } from 'vitest';
import type { SessionMeta, User } from '@trinity-harness/contracts';
import {
  TrustedCdpBrowserAccess,
  MemorySessionStore,
  isCdpSessionOwner,
  matchesBrowserCdpEndpoint,
} from '../src/index.js';
import { FakeSandbox } from '../src/testing/index.js';
const websocket = 'ws://127.0.0.1:9222/devtools/browser/test-browser';
const envelope = (value: unknown) => JSON.stringify({ success: true, data: value });
function assembly(currentUrl = 'https://example.com/') {
  const sandbox = new FakeSandbox();
  const calls: string[][] = [];
  const store = new MemorySessionStore();
  sandbox.argvHandler = async (command, args, opts) => {
    expect(command).toBe('agent-browser');
    expect(opts.maxOutputBytes).toBeLessThanOrEqual(32 * 1024);
    calls.push(args);
    return {
      stdout:
        args[0] === '--version'
          ? 'agent-browser 0.38.2'
          : envelope(
              args.includes('cdp-url')
                ? { cdpUrl: websocket, lifecycle: { launched: false } }
                : args.includes('list')
                  ? { tabs: [{ active: true, targetId: 'owned-target' }] }
                  : {
                      result: {
                        url: currentUrl,
                        documentRevision: '123_4',
                        browserVersion: 'Chrome/151.0.0.0',
                      },
                    },
            ),
      stderr: '',
      exitCode: 0,
      outputOverflow: false,
    };
  };
  return {
    sandbox,
    store,
    calls,
    access: new TrustedCdpBrowserAccess({
      endpoint: '9222',
      sandbox,
      store,
      authorizeSession: async () => true,
    }),
  };
}
describe('explicit trusted CDP attachment', () => {
  it.each([
    '9222',
    'http://localhost:9222',
    'http://127.0.0.1:9222/',
    'ws://localhost:9222/devtools/browser/test-browser',
  ])('matches discovered WebSocket for %s', (expected) => {
    expect(matchesBrowserCdpEndpoint(expected, websocket)).toBe(true);
  });
  it.each([
    'http://other:9222',
    '9223',
    'https://localhost:9222',
    'ws://localhost:9222/devtools/browser/different',
    'file:///9222',
    'https://user:secret@localhost:9222',
  ])('rejects mismatched or unsafe endpoint %s', (expected) => {
    expect(matchesBrowserCdpEndpoint(expected, websocket)).toBe(false);
  });
  it('uses a deterministic owned named session and explicit flags on every browser command', async () => {
    const { access, calls } = assembly();
    const binding = await access.authorize('s', 'get_page_text', undefined);
    expect(binding).toMatchObject({
      securityMode: 'trusted-cdp',
      cdpEndpoint: '9222',
      documentRevision: '123_4',
      browserVersion: 'Chrome/151.0.0.0',
      observedUrl: 'https://example.com/',
    });
    for (const args of calls.slice(1))
      expect(args.slice(0, 6)).toEqual([
        '--session',
        binding.cliSession,
        '--cdp',
        '9222',
        '--pin-tab',
        '--json',
      ]);
    expect(await access.authorize('s', 'get_page_text', undefined)).toEqual(binding);
    expect((await access.authorize('other', 'get_page_text', undefined)).cliSession).not.toBe(
      binding.cliSession,
    );
    expect(calls.flat()).not.toContain('close');
    expect(calls.flat()).not.toContain('connect');
  });
  it('denies an unauthenticated/non-owner session before CLI effects', async () => {
    const { sandbox, calls, store } = assembly();
    const access = new TrustedCdpBrowserAccess({
      endpoint: '9222',
      sandbox,
      store,
      authorizeSession: async () => false,
    });
    await expect(access.authorize('s', 'navigate', 'https://example.com/')).rejects.toMatchObject({
      code: 'CDP_OWNER_DENIED',
    });
    expect(calls).toHaveLength(0);
  });
  it.each(['connection', 'launch', 'version', 'overflow', 'invalid'])(
    'fails closed on %s without managed fallback',
    async (kind) => {
      const { sandbox, access, calls } = assembly();
      const original = sandbox.argvHandler!;
      sandbox.argvHandler = async (c, args, o) => {
        const result = await original(c, args, o);
        if (kind === 'version' && args[0] === '--version') result.stdout = 'agent-browser 9.0.0';
        if (args.includes('cdp-url')) {
          if (kind === 'connection')
            result.stdout = envelope({ cdpUrl: 'ws://127.0.0.1:9333/devtools/browser/wrong' });
          if (kind === 'launch')
            result.stdout = envelope({ cdpUrl: websocket, lifecycle: { launched: true } });
          if (kind === 'overflow') result.outputOverflow = true;
          if (kind === 'invalid') result.stdout = 'private failure';
        }
        return result;
      };
      await expect(access.authorize('s', 'get_page_text', undefined)).rejects.toThrow();
      expect(calls.filter((args) => args.includes('open'))).toEqual([]);
    },
  );
  it('allows explicit HTTP navigation out of the owned Chrome error page, but refuses evidence reads', async () => {
    const { access, calls } = assembly('chrome-error://chromewebdata/');
    await expect(
      access.authorize('s', 'navigate', 'https://example.com/recovery'),
    ).resolves.toMatchObject({
      tabId: 'owned-target',
      observedUrl: 'chrome-error://chromewebdata/',
    });
    for (const operation of [
      'get_page_text',
      'read_page',
      'screenshot',
      'click',
      'navigate',
    ] as const)
      await expect(access.authorize('s', operation, undefined)).rejects.toMatchObject({
        code: 'CDP_PAGE_UNAVAILABLE',
        failure: { code: 'PAGE_UNAVAILABLE', recovery: 'navigate' },
      });
    const count = calls.length;
    await expect(access.authorize('s', 'navigate', 'javascript:alert(1)')).rejects.toThrow();
    expect(calls).toHaveLength(count);
    expect(calls.flat()).not.toContain('open');
  });
  it.each([
    'chrome://settings/',
    'file:///private',
    'data:text/html,private',
    'chrome-error://other/',
  ])('does not generalize error-page recovery to %s', async (url) => {
    const { access } = assembly(url);
    await expect(access.authorize('s', 'navigate', 'https://example.com/')).rejects.toMatchObject({
      code: 'CDP_UNSUPPORTED_DOCUMENT',
      failure: { code: 'NOT_AUTHORIZED', recovery: 'conclude' },
    });
  });
  it('rejects unexpected document changes and cancellation', async () => {
    const { access, calls } = assembly();
    await expect(
      access.authorize('s', 'get_page_text', 'https://example.com/changed'),
    ).rejects.toMatchObject({ code: 'CDP_DOCUMENT_CHANGED' });
    const count = calls.length;
    await expect(
      access.authorize('s', 'navigate', 'https://example.com/', AbortSignal.abort()),
    ).rejects.toThrow();
    expect(calls).toHaveLength(count);
  });
});

describe('shared CDP owner authorization', () => {
  const user: User = {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-000000000002',
    email: 'owner@example.com',
    role: 'admin',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const session: SessionMeta = {
    id: '00000000-0000-4000-8000-000000000003',
    tenantId: user.tenantId,
    userId: user.id,
    title: 'test',
    workspaceUri: '/ws',
    scope: 'personal',
    createdAt: user.createdAt,
  };
  const users = {
    findById: async (id: string) => (id === user.id ? user : null),
    findByEmail: async (email: string) => (email === user.email ? user : null),
  };
  it('accepts the configured owner by ID or bootstrap email', async () => {
    expect(
      await isCdpSessionOwner('s', { get: async () => session }, users, { email: user.email }),
    ).toBe(true);
    expect(
      await isCdpSessionOwner('s', { get: async () => session }, users, {
        id: user.id,
        email: 'unused',
      }),
    ).toBe(true);
  });
  it.each([
    null,
    { ...session, userId: 'other' },
    { ...session, tenantId: 'other' },
    { ...session, scope: 'team' as const },
    { ...session, closedAt: user.createdAt },
  ])('denies absent, other-user/tenant, team or closed session', async (value) => {
    expect(
      await isCdpSessionOwner('s', { get: async () => value }, users, { email: user.email }),
    ).toBe(false);
  });
});

it('restores the owned Chrome target from committed session results after adapter restart', async () => {
  const { access, store, sandbox, calls } = assembly();
  const binding = await access.authorize('s', 'get_page_text', undefined);
  const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-01-01T00:00:00.000Z' });
  await store.append('s', [
    {
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: 'capture',
      args: { operation: 'get_page_text' },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'capture',
      isError: false,
      value: {
        kind: 'browser-result-v1',
        operation: 'get_page_text',
        callId: 'capture',
        sessionId: 's',
        observationId: 'observation',
        artifactUri: 'blob://browser/s/observation.json',
        url: 'https://example.com/',
        title: 'test',
        capturedAt: meta().at,
        bindingId: binding.bindingId,
        tabId: binding.tabId,
        documentRevision: '123_4',
        securityMode: 'trusted-cdp',
        readiness: 'ready',
        saved: false,
        captureTruncated: false,
        outputTruncated: false,
        representation: 'article',
        scope: 'main',
        exclusions: [],
        publishedAt: null,
        outline: [],
        duplicateSuppressed: false,
        blocks: [],
        receipt: [],
        continuation: null,
      },
    },
  ]);
  calls.length = 0;
  const restarted = new TrustedCdpBrowserAccess({
    endpoint: '9222',
    sandbox,
    store,
    authorizeSession: async () => true,
  });
  expect((await restarted.authorize('s', 'get_page_text', undefined)).tabId).toBe('owned-target');
  expect(calls.some((args) => args.at(-2) === 'tab' && args.at(-1) === 'owned-target')).toBe(true);
  expect(calls.findIndex((args) => args.at(-1) === 'owned-target')).toBeLessThan(
    calls.findIndex((args) => args.includes('eval')),
  );
});

it('rechecks the authenticated parent for an isolated delegated binding and denies revocation before CLI effects', async () => {
  const { sandbox, store, calls, access } = assembly();
  const parent = await access.authorize('parent', 'navigate', 'https://example.com/');
  let parentAllowed = true;
  let ownershipChecks = 0;
  const child = new TrustedCdpBrowserAccess({
    endpoint: '9222',
    sandbox,
    store,
    authorizeSession: async (sessionId) => {
      ownershipChecks += 1;
      return sessionId === 'child' && parentAllowed;
    },
  });
  const binding = await child.authorize('child', 'navigate', 'https://example.com/');
  expect(binding.cliSession).not.toBe(parent.cliSession);
  expect(binding.bindingId).not.toBe(parent.bindingId);
  parentAllowed = false;
  const count = calls.length;
  await expect(child.authorize('child', 'navigate', 'https://example.com/')).rejects.toMatchObject({
    code: 'CDP_OWNER_DENIED',
  });
  expect(calls).toHaveLength(count);
  parentAllowed = true;
  await expect(child.authorize('forged', 'navigate', 'https://example.com/')).rejects.toMatchObject(
    { code: 'CDP_OWNER_DENIED' },
  );
  expect(calls).toHaveLength(count);
  expect(ownershipChecks).toBe(3);
});
