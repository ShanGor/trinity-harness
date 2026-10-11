import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  browserCdpEndpointSchema,
  browserUrlSchema,
  type BrowserAccessPort,
  type BrowserArguments,
  type BrowserBinding,
  type SandboxPort,
  type SessionStore,
  type SessionMetaStore,
  type UserStore,
} from '@trinity-harness/contracts';
import { browserDeliveries } from './browser-artifacts.js';

/** CLI envelopes are untrusted external JSON; callers validate the unwrapped DTO. */
export function unwrapBrowserCliOutput(stdout: string): unknown {
  let value: unknown = JSON.parse(stdout);
  for (let i = 0; i < 5; i++) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return value;
      }
      continue;
    }
    if (!value || typeof value !== 'object') break;
    const object = value as Record<string, unknown>;
    if (object.success === false) throw new CdpAccessError('CDP_OPERATION_FAILED');
    const lifecycle = object.lifecycle as Record<string, unknown> | undefined;
    if (lifecycle?.launched === true || lifecycle?.relaunchedBrowser === true)
      throw new CdpAccessError('CDP_UNEXPECTED_LAUNCH');
    if ('success' in object || 'result' in object) {
      value = object.result ?? object.data;
      continue;
    }
    break;
  }
  return value;
}

/** Discovery translates an HTTP endpoint/port to a browser WebSocket URL. */
export function matchesBrowserCdpEndpoint(expected: string, observed: string): boolean {
  try {
    const requested = new URL(/^\d+$/.test(expected) ? `http://127.0.0.1:${expected}` : expected);
    const actual = new URL(observed);
    if (
      !['http:', 'https:', 'ws:', 'wss:'].includes(requested.protocol) ||
      !['ws:', 'wss:'].includes(actual.protocol) ||
      requested.username ||
      requested.password ||
      actual.username ||
      actual.password ||
      requested.search ||
      requested.hash ||
      actual.search ||
      actual.hash
    )
      return false;
    const host = (value: string): string =>
      ['localhost', '127.0.0.1', '[::1]'].includes(value) ? 'loopback' : value;
    const port = (url: URL): string =>
      url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
    if (host(requested.hostname) !== host(actual.hostname) || port(requested) !== port(actual))
      return false;
    if (['https:', 'wss:'].includes(requested.protocol) !== (actual.protocol === 'wss:'))
      return false;
    return !['ws:', 'wss:'].includes(requested.protocol) || requested.pathname === actual.pathname;
  } catch {
    return false;
  }
}
export class CdpAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface TrustedCdpBrowserOptions {
  endpoint: string;
  sandbox: SandboxPort;
  store: SessionStore;
  /** Must check the authenticated session's owner/trust domain, closed state and access. */
  authorizeSession: (sessionId: string, signal?: AbortSignal) => Promise<boolean>;
}
const stateSchema = z.object({
  url: z.string().max(2000),
  documentRevision: z
    .string()
    .regex(/^[0-9_]+$/)
    .max(100),
  browserVersion: z.string().min(1).max(100),
});
const stateScript =
  '({url:location.href,documentRevision:String(performance.timeOrigin).replace(".","_"),browserVersion:(navigator.userAgent.match(/Chrome\\/[0-9.]+/)||["unknown"])[0]})';

/** Explicit user-owned Chrome attachment. This does not assert an egress firewall or cookie isolation. */
export class TrustedCdpBrowserAccess implements BrowserAccessPort {
  private readonly endpoint: string;
  constructor(private readonly options: TrustedCdpBrowserOptions) {
    this.endpoint = browserCdpEndpointSchema.parse(options.endpoint);
  }
  async authorize(
    sessionId: string,
    operation: BrowserArguments['operation'],
    url: string | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserBinding> {
    signal?.throwIfAborted();
    if (!(await this.options.authorizeSession(sessionId, signal)))
      throw new CdpAccessError('CDP_OWNER_DENIED');
    if (url !== undefined) browserUrlSchema.parse(url);
    const sandbox = this.options.sandbox;
    if (!sandbox.execArgv) throw new CdpAccessError('CDP_BOUNDED_EXEC_REQUIRED');
    const run = async (args: string[], maxOutputBytes: number): Promise<string> => {
      signal?.throwIfAborted();
      const result = await sandbox.execArgv!('agent-browser', args, {
        maxOutputBytes,
        signal,
        timeoutMs: 10_000,
      });
      signal?.throwIfAborted();
      if (result.outputOverflow || result.exitCode !== 0)
        throw new CdpAccessError('CDP_PROBE_FAILED');
      return result.stdout;
    };
    const version = (await run(['--version'], 1024)).trim();
    // The attached CLI protocol was validated against 0.38.x; upgrades require adapter tests.
    const parsedVersion = /^agent-browser (0\.38\.\d+)$/.exec(version)?.[1];
    if (!parsedVersion) throw new CdpAccessError('CDP_UNSUPPORTED_CLI');
    const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
    const cliSession = `trinity-${digest}`;
    const flags = ['--session', cliSession, '--cdp', this.endpoint, '--pin-tab', '--json'];
    const connection = z
      .object({ cdpUrl: z.string().max(2000) })
      .parse(unwrapBrowserCliOutput(await run([...flags, 'get', 'cdp-url'], 8192)));
    if (!matchesBrowserCdpEndpoint(this.endpoint, connection.cdpUrl))
      throw new CdpAccessError('CDP_CONNECTION_MISMATCH');
    const bindingId = createHash('sha256')
      .update(`${connection.cdpUrl}\n${sessionId}`)
      .digest('hex')
      .slice(0, 32);
    const events = await this.options.store.load(sessionId);
    signal?.throwIfAborted();
    const saved = browserDeliveries(events, sessionId)
      .reverse()
      .find(
        (delivery) =>
          delivery.result.bindingId === bindingId && delivery.result.securityMode === 'trusted-cdp',
      );
    if (saved) await run([...flags, 'tab', saved.result.tabId], 8192);
    // Discard the inventory after resolving the single owned target. Never deliver other tabs.
    const tabs = z
      .object({
        tabs: z
          .array(
            z.object({ active: z.boolean(), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }),
          )
          .max(200),
      })
      .parse(unwrapBrowserCliOutput(await run([...flags, 'tab', 'list'], 32 * 1024)));
    const active = tabs.tabs.filter((tab) => tab.active);
    if (active.length !== 1 || (saved && active[0]!.targetId !== saved.result.tabId))
      throw new CdpAccessError('CDP_TAB_CHANGED');
    const state = stateSchema.parse(
      unwrapBrowserCliOutput(await run([...flags, 'eval', stateScript], 8192)),
    );
    // Only an adapter-created blank tab may precede the first HTTP navigation.
    if (state.url !== 'about:blank') browserUrlSchema.parse(state.url);
    if (url !== undefined && operation !== 'navigate' && state.url !== url)
      throw new CdpAccessError('CDP_DOCUMENT_CHANGED');
    return {
      bindingId,
      tabId: active[0]!.targetId,
      cliSession,
      documentRevision: state.documentRevision,
      cliVersion: parsedVersion,
      browserVersion: state.browserVersion,
      cdpEndpoint: this.endpoint,
      securityMode: 'trusted-cdp',
      observedUrl: state.url,
    };
  }
}

/** A shared Chrome endpoint is restricted to one configured authenticated owner. */
export async function isCdpSessionOwner(
  sessionId: string,
  metas: Pick<SessionMetaStore, 'get'>,
  users: Pick<UserStore, 'findById' | 'findByEmail'>,
  owner: { id?: string; email: string },
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const session = await metas.get(sessionId);
  if (!session || session.closedAt || session.scope === 'team') return false;
  const user = owner.id ? await users.findById(owner.id) : await users.findByEmail(owner.email);
  signal?.throwIfAborted();
  return Boolean(user && session.userId === user.id && session.tenantId === user.tenantId);
}
