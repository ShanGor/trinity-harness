import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  browserPreviewSchema,
  type BrowserPreview,
  type BrowserPreviewPort,
  BROWSER_LIMITS,
  browserArgumentsSchema,
  browserRuntimeRequestSchema,
  browserRuntimeResultSchema,
  type BrowserRuntimePort,
  type BrowserRuntimeRequest,
  type BrowserRuntimeResult,
  type BrowserRuntimeStore,
  type ManagedBrowserSession,
  type SessionStore,
} from '@trinity-harness/contracts';
import { canonicalBrowserJson } from './browser-artifacts.js';

/** The authenticated internal caller must also identify a matching active log call. */
export async function authorizeManagedBrowserCommand(
  request: BrowserRuntimeRequest,
  store: SessionStore,
  authorizeOwner: (sessionId: string, signal?: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (!(await authorizeOwner(request.sessionId, signal))) return false;
  const events = await store.load(request.sessionId);
  signal.throwIfAborted();
  const callIndex = events.findLastIndex(
    (event) =>
      event.type === 'tool/call' && event.callId === request.callId && event.name === 'browser',
  );
  const call = events[callIndex];
  if (
    !call ||
    call.type !== 'tool/call' ||
    events
      .slice(callIndex + 1)
      .some(
        (event) =>
          event.type === 'turn/end' ||
          event.type === 'turn/cancel_requested' ||
          event.type === 'session/closed',
      )
  )
    return false;
  const parsed = browserArgumentsSchema.safeParse(call.args);
  if (!parsed.success || ['read_observation', 'search_observation'].includes(parsed.data.operation))
    return false;
  return (
    canonicalBrowserJson(parsed.data) === canonicalBrowserJson(request.args) &&
    (!['click', 'fill', 'scroll', 'key'].includes(parsed.data.operation) ||
      request.permissionGranted)
  );
}

export function browserRuntimeFailure(
  request: BrowserRuntimeRequest,
  code: 'DRIVER_FAILED' | 'NOT_AUTHORIZED' | 'NOT_EXECUTED' | 'CANCELLED',
  effect: 'none' | 'unknown' = 'none',
): BrowserRuntimeResult {
  return {
    isError: true,
    value: {
      kind: 'browser-error-v1',
      operation: request.args.operation,
      code,
      effect,
      message:
        'Managed browser operation unavailable. Reobserve after an uncertain effect; never repeat it automatically.',
      recovery: 'reobserve',
    },
  };
}

export const browserRuntimeEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/' &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  );
}, 'Expected HTTPS runtime origin, or loopback HTTP');
export const browserDeploymentEnvShape = {
  BROWSER_DRIVER: z.enum(['agent-browser', 'zendriver']).default('agent-browser'),
  BROWSER_RUNTIME_ENDPOINT: browserRuntimeEndpointSchema.optional(),
  BROWSER_RUNTIME_TOKEN: z.string().min(32).max(200).optional(),
};
export function validateBrowserDeployment(env: {
  BROWSER_DRIVER: string;
  BROWSER_RUNTIME_ENDPOINT?: string;
  BROWSER_RUNTIME_TOKEN?: string;
  BROWSER_CDP_ENDPOINT?: string;
}): void {
  if (env.BROWSER_DRIVER === 'zendriver') {
    const missing = [
      ...(!env.BROWSER_RUNTIME_ENDPOINT ? ['BROWSER_RUNTIME_ENDPOINT'] : []),
      ...(!env.BROWSER_RUNTIME_TOKEN ? ['BROWSER_RUNTIME_TOKEN'] : []),
    ];
    if (missing.length)
      throw new Error(
        `Zendriver is selected, but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing. ` +
          'Set the endpoint (usually http://127.0.0.1:3010) and the same private token in server, worker, and browser-runtime environments, then start the local supervisor with `pnpm dev:browser-runtime`.',
      );
    if (env.BROWSER_CDP_ENDPOINT)
      throw new Error(
        'Zendriver is selected while BROWSER_CDP_ENDPOINT is also set. Remove BROWSER_CDP_ENDPOINT; Zendriver manages its own Chrome.',
      );
  } else if (env.BROWSER_RUNTIME_ENDPOINT || env.BROWSER_RUNTIME_TOKEN)
    throw new Error('BROWSER_RUNTIME settings require BROWSER_DRIVER=zendriver');
}

export class HttpBrowserRuntime implements BrowserRuntimePort, BrowserPreviewPort {
  private readonly endpoint: string;
  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.endpoint = browserRuntimeEndpointSchema.parse(endpoint);
    z.string().min(32).max(200).parse(token);
  }
  async execute(input: BrowserRuntimeRequest, signal?: AbortSignal): Promise<BrowserRuntimeResult> {
    const request = browserRuntimeRequestSchema.parse(input);
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(115_000)]);
    let response: Response;
    try {
      response = await this.fetcher(new URL('/execute', this.endpoint), {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: deadline,
      });
    } catch {
      // Transport failures (runtime not running, connection refused) name the
      // deployment gap so the caller reports it instead of retrying blindly.
      if (deadline.aborted) return browserRuntimeFailure(request, 'CANCELLED', 'unknown');
      return {
        isError: true,
        value: {
          kind: 'browser-error-v1',
          operation: request.args.operation,
          code: 'DRIVER_FAILED',
          effect: 'unknown',
          message: `The managed browser runtime at ${this.endpoint} is unreachable (connection refused or not running). Report that the browser runtime must be started before browser tasks can run; do not retry or launch a replacement browser.`,
          recovery: 'conclude',
        },
      };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return browserRuntimeFailure(request, 'DRIVER_FAILED', 'unknown');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > BROWSER_LIMITS.focused + 2048)
          throw new Error('Browser runtime response overflow');
        chunks.push(next.value);
      }
      const result = browserRuntimeResultSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (
        result.value.operation !== request.args.operation ||
        (result.value.kind === 'browser-result-v1' &&
          (result.value.sessionId !== request.sessionId || result.value.callId !== request.callId))
      )
        throw new Error('Browser runtime result mismatch');
      return result;
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  async preview(sessionId: string, signal?: AbortSignal): Promise<BrowserPreview> {
    z.uuid().parse(sessionId);
    let response: Response;
    try {
      response = await this.fetcher(new URL('/preview', this.endpoint), {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]),
      });
    } catch {
      signal?.throwIfAborted();
      return { state: 'runtime_unavailable' };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { state: 'runtime_unavailable' };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 2_800_000) throw new Error('Browser preview response overflow');
        chunks.push(next.value);
      }
      return browserPreviewSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}

export interface ManagedBrowserSupervisorOptions {
  store: BrowserRuntimeStore;
  owner: string;
  authorize: (request: BrowserRuntimeRequest, signal: AbortSignal) => Promise<boolean>;
  authorizePreview?: (sessionId: string, signal: AbortSignal) => Promise<boolean>;
  create: (request: BrowserRuntimeRequest, signal: AbortSignal) => Promise<ManagedBrowserSession>;
  maxSessions: number;
  idleMs: number;
}

/** Stateful sandbox supervisor. Workers only hold HTTP clients. */
export class ManagedBrowserSupervisor implements BrowserRuntimePort, BrowserPreviewPort {
  private readonly sessions = new Map<string, ManagedBrowserSession>();
  private readonly idle = new Map<string, AbortController>();
  private readonly shutdown = new AbortController();
  private allocating = 0;
  private readonly activeOperations = new Map<string, AbortController>();
  private readonly stopping = new WeakMap<ManagedBrowserSession, Promise<void>>();
  constructor(private readonly options: ManagedBrowserSupervisorOptions) {}
  private stop(session: ManagedBrowserSession): Promise<void> {
    let pending = this.stopping.get(session);
    if (!pending) {
      pending = session.dispose();
      this.stopping.set(session, pending);
    }
    return pending;
  }
  private async destroy(sessionId: string): Promise<void> {
    this.idle.get(sessionId)?.abort();
    this.idle.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) await this.stop(session);
    this.sessions.delete(sessionId);
    const record = await this.options.store.binding(sessionId);
    if (session && record?.owner === this.options.owner && record.generation === session.generation)
      await this.options.store.bind({ ...record, status: 'invalid' });
  }
  private async executeLocked(
    request: BrowserRuntimeRequest,
    active: AbortSignal,
  ): Promise<BrowserRuntimeResult> {
    active.throwIfAborted();
    if (!(await this.options.authorize(request, active))) {
      await this.destroy(request.sessionId);
      return browserRuntimeFailure(request, 'NOT_AUTHORIZED');
    }
    const hash = createHash('sha256').update(canonicalBrowserJson(request)).digest('hex');
    const previous = await this.options.store.command(request.sessionId, request.callId);
    if (previous) {
      if (previous.hash !== hash) return browserRuntimeFailure(request, 'NOT_AUTHORIZED');
      if (previous.result) return previous.result;
      await this.destroy(request.sessionId);
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    }
    this.idle.get(request.sessionId)?.abort();
    this.idle.delete(request.sessionId);
    let session = this.sessions.get(request.sessionId);
    const record = await this.options.store.binding(request.sessionId);
    if (session && this.stopping.has(session))
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    if (record?.status === 'active' && (record.owner !== this.options.owner || !session))
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    if (session && (record?.generation !== session.generation || record.status !== 'active')) {
      await this.destroy(request.sessionId);
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    }
    if (!session) {
      if (this.sessions.size + this.allocating >= this.options.maxSessions)
        return browserRuntimeFailure(request, 'NOT_EXECUTED');
      this.allocating++;
      try {
        session = await this.options.create(request, active);
        try {
          await this.options.store.bind({
            sessionId: request.sessionId,
            owner: this.options.owner,
            generation: session.generation,
            status: 'active',
          });
          this.sessions.set(request.sessionId, session);
        } catch (err) {
          await session.dispose();
          throw err;
        }
      } finally {
        this.allocating--;
      }
    }
    await this.options.store.begin(request.sessionId, request.callId, hash, session.generation);
    const result = browserRuntimeResultSchema.parse(await session.execute(request, active));
    active.throwIfAborted();
    await this.options.store.finish(request.sessionId, request.callId, result);
    active.throwIfAborted();
    if (result.isError) await this.destroy(request.sessionId);
    else {
      const cancelIdle = new AbortController();
      this.idle.set(request.sessionId, cancelIdle);
      AbortSignal.any([
        AbortSignal.timeout(this.options.idleMs),
        cancelIdle.signal,
      ]).addEventListener(
        'abort',
        () => {
          if (!cancelIdle.signal.aborted)
            void this.options.store
              .run(request.sessionId, async () => {
                if (!cancelIdle.signal.aborted) await this.destroy(request.sessionId);
              })
              .catch(() => {
                this.shutdown.abort();
                for (const session of this.sessions.values())
                  void this.stop(session).catch(() => {
                    this.shutdown.abort();
                  });
              });
        },
        { once: true },
      );
    }
    return result;
  }
  async execute(input: BrowserRuntimeRequest, signal?: AbortSignal): Promise<BrowserRuntimeResult> {
    const request = browserRuntimeRequestSchema.parse(input);
    const deadline = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(110_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      return await this.options.store.run(
        request.sessionId,
        async (lockSignal) => {
          const stop = new AbortController();
          this.activeOperations.set(request.sessionId, stop);
          const active = AbortSignal.any([deadline, lockSignal, stop.signal]);
          try {
            return await this.executeLocked(request, active);
          } catch (err) {
            await this.destroy(request.sessionId);
            throw err;
          } finally {
            this.activeOperations.delete(request.sessionId);
          }
        },
        deadline,
      );
    } catch {
      return browserRuntimeFailure(
        request,
        deadline.aborted ? 'CANCELLED' : 'DRIVER_FAILED',
        'unknown',
      );
    }
  }
  async dispose(): Promise<void> {
    this.shutdown.abort();
    await Promise.all([...this.sessions.values()].map((session) => this.stop(session)));
    await Promise.all(
      [...this.sessions.keys()].map((id) =>
        this.options.store.run(id, async () => this.destroy(id)),
      ),
    );
  }
  async preview(sessionId: string, signal?: AbortSignal): Promise<BrowserPreview> {
    z.uuid().parse(sessionId);
    const active = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(5000),
      ...(signal ? [signal] : []),
    ]);
    try {
      if (!(await this.options.authorizePreview?.(sessionId, active)))
        return { state: 'unavailable' };
      // A spectator must not queue behind a long action or keep the idle lease alive.
      if (this.activeOperations.has(sessionId)) return { state: 'busy' };
      return await this.options.store.run(
        sessionId,
        async (lockSignal) => {
          const captureSignal = AbortSignal.any([active, lockSignal]);
          const session = this.sessions.get(sessionId);
          const record = await this.options.store.binding(sessionId);
          if (
            !session?.preview ||
            this.stopping.has(session) ||
            record?.status !== 'active' ||
            record.owner !== this.options.owner ||
            record.generation !== session.generation
          )
            return { state: 'unavailable' };
          const result = browserPreviewSchema.parse(await session.preview(captureSignal));
          captureSignal.throwIfAborted();
          if (
            !(await this.options.authorizePreview?.(sessionId, captureSignal)) ||
            (result.state === 'frame' && result.generation !== session.generation)
          )
            return { state: 'unavailable' };
          return result;
        },
        active,
      );
    } catch {
      return { state: signal?.aborted || this.shutdown.signal.aborted ? 'unavailable' : 'busy' };
    }
  }
  async close(sessionId: string): Promise<void> {
    this.activeOperations.get(sessionId)?.abort();
    await this.options.store.run(sessionId, async () => this.destroy(sessionId));
  }
}
