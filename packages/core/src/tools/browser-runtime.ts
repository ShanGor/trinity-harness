import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
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
  browserInteractionRequestSchema,
  browserInteractionResultSchema,
  type BrowserInteractionPort,
  type BrowserInteractionStore,
  type BrowserInteractionRequest,
  type BrowserInteractionResult,
  type BrowserControlRecord,
  type BrowserControlState,
  type BrowserSessionScope,
} from '@trinity-harness/contracts';
import { canonicalBrowserJson } from './browser-artifacts.js';
import { BrowserDriverError } from './browser-driver-error.js';

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

export class HttpBrowserRuntime
  implements BrowserRuntimePort, BrowserPreviewPort, BrowserInteractionPort
{
  private readonly endpoint: string;
  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.endpoint = browserRuntimeEndpointSchema.parse(endpoint);
    z.string().min(32).max(200).parse(token);
  }
  async interact(
    input: BrowserInteractionRequest,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    const request = browserInteractionRequestSchema.parse(input);
    const response = await this.fetcher(new URL('/interaction', this.endpoint), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(65_000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Browser interaction unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2_900_000) throw new Error('Browser interaction response overflow');
        chunks.push(chunk.value);
      }
      return browserInteractionResultSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
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
  scope?: BrowserSessionScope;
  owner: string;
  authorize: (request: BrowserRuntimeRequest, signal: AbortSignal) => Promise<boolean>;
  authorizePreview?: (sessionId: string, signal: AbortSignal) => Promise<boolean>;
  create: (request: BrowserRuntimeRequest, signal: AbortSignal) => Promise<ManagedBrowserSession>;
  maxSessions: number;
  idleMs: number;
  interactionStore?: BrowserInteractionStore;
  events?: Pick<SessionStore, 'append'>;
  now?: () => Date;
}

interface BrowserIntervention {
  settled: boolean;
  closed: boolean;
  released: Promise<void>;
  release(): void;
}
interface ActiveBrowserOperation {
  stop: AbortController;
  signal: AbortSignal;
  intervention?: BrowserIntervention;
}

/** Stateful sandbox supervisor. Workers only hold HTTP clients. */
export class ManagedBrowserSupervisor
  implements BrowserRuntimePort, BrowserPreviewPort, BrowserInteractionPort
{
  private readonly sessions = new Map<string, ManagedBrowserSession>();
  private readonly idle = new Map<string, AbortController>();
  private readonly leases = new Map<string, AbortController>();
  private readonly shutdown = new AbortController();
  private allocating = 0;
  private readonly activeOperations = new Map<string, ActiveBrowserOperation>();
  private readonly stopping = new WeakMap<ManagedBrowserSession, Promise<void>>();
  constructor(private readonly options: ManagedBrowserSupervisorOptions) {}
  private controlState(record?: BrowserControlRecord | null, viewId?: string): BrowserControlState {
    return record
      ? {
          available: true,
          mode: record.mode,
          generation: record.generation,
          epoch: record.epoch,
          controllerId: record.controllerId === viewId ? record.controllerId : null,
          expiresAt: record.expiresAt,
          nextSequence: record.sequence + 1,
        }
      : {
          available: false,
          mode: 'paused',
          generation: null,
          epoch: 0,
          controllerId: null,
          expiresAt: null,
          nextSequence: 1,
        };
  }
  private async controlEvent(
    record: BrowserControlRecord,
    source = record.sessionId,
  ): Promise<void> {
    await this.options.events?.append(source, [
      {
        type: 'browser/control_changed',
        eventId: randomUUID(),
        at: this.now().toISOString(),
        generation: record.generation,
        epoch: record.epoch,
        mode: record.mode,
      },
    ]);
  }
  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
  private async scopeFor(sessionId: string, signal: AbortSignal): Promise<string | null> {
    return this.options.scope ? this.options.scope.resolve(sessionId, signal) : sessionId;
  }
  private async canView(source: string, scope: string, signal: AbortSignal): Promise<boolean> {
    return !!(
      (await this.options.authorizePreview?.(source, signal)) &&
      (await this.scopeFor(source, signal)) === scope &&
      (source === scope || (await this.options.authorizePreview?.(scope, signal)))
    );
  }
  private failTimers(): void {
    this.shutdown.abort();
    // Stop Chrome even when the durable lock service is unavailable.
    void Promise.allSettled([...this.sessions.values()].map((session) => this.stop(session)));
  }
  private armIdle(sessionId: string): void {
    this.idle.get(sessionId)?.abort();
    const cancel = new AbortController();
    this.idle.set(sessionId, cancel);
    AbortSignal.any([
      cancel.signal,
      this.shutdown.signal,
      AbortSignal.timeout(this.options.idleMs),
    ]).addEventListener(
      'abort',
      () => {
        if (!cancel.signal.aborted && !this.shutdown.signal.aborted)
          void this.options.store
            .run(
              sessionId,
              async () => {
                if (!cancel.signal.aborted) await this.destroy(sessionId);
              },
              this.shutdown.signal,
            )
            .catch(() => this.failTimers());
      },
      { once: true },
    );
  }
  private armLease(record: BrowserControlRecord): void {
    this.leases.get(record.sessionId)?.abort();
    if (record.mode !== 'human' || !record.expiresAt) {
      this.leases.delete(record.sessionId);
      return;
    }
    const cancel = new AbortController();
    this.leases.set(record.sessionId, cancel);
    const delay = Math.max(1, Date.parse(record.expiresAt) - this.now().getTime());
    AbortSignal.any([
      cancel.signal,
      this.shutdown.signal,
      AbortSignal.timeout(delay),
    ]).addEventListener(
      'abort',
      () => {
        if (cancel.signal.aborted || this.shutdown.signal.aborted) return;
        const intervention = this.activeOperations.get(record.sessionId)?.intervention;
        const desktopLock = intervention && !intervention.closed;
        void this.options.store
          .run(
            desktopLock ? `desktop:${record.sessionId}` : record.sessionId,
            async () => {
              if (cancel.signal.aborted) return;
              if (
                desktopLock &&
                this.activeOperations.get(record.sessionId)?.intervention !== intervention
              )
                return;
              const current = await this.control(record.sessionId);
              if (current?.mode === 'human') this.armLease(current);
              else if (current?.mode === 'paused' && intervention?.settled) intervention.release();
            },
            this.shutdown.signal,
          )
          .catch(() => this.failTimers());
      },
      { once: true },
    );
  }
  private async control(sessionId: string): Promise<BrowserControlRecord | null> {
    const record = (await this.options.interactionStore?.get(sessionId)) ?? null;
    if (
      record?.mode === 'human' &&
      record.expiresAt &&
      Date.parse(record.expiresAt) <= this.now().getTime()
    ) {
      record.mode = 'paused';
      record.epoch++;
      record.controllerId = null;
      record.expiresAt = null;
      record.frame = null;
      record.frames = [];
      record.keyboard = null;
      await this.options.interactionStore!.put(record);
      await this.controlEvent(record);
      this.armIdle(sessionId);
    }
    return record;
  }
  async interact(
    input: BrowserInteractionRequest,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    const request = browserInteractionRequestSchema.parse(input);
    let admitted = false;
    let activated: BrowserIntervention | undefined;
    let takeCommitted = false;
    const disconnected = new AbortController();
    const disconnect = (): void => {
      if (!admitted || request.operation === 'input') disconnected.abort();
    };
    signal?.addEventListener('abort', disconnect, { once: true });
    if (signal?.aborted) disconnect();
    const active = AbortSignal.any([
      this.shutdown.signal,
      disconnected.signal,
      AbortSignal.timeout(60_000),
    ]);
    const failure = (
      code: NonNullable<BrowserInteractionResult['error']>['code'],
      message: string,
      record?: BrowserControlRecord | null,
    ): BrowserInteractionResult => ({
      state: this.controlState(record, request.viewId),
      error: { code, message },
    });
    if (!this.options.interactionStore || !this.options.authorizePreview) {
      signal?.removeEventListener('abort', disconnect);
      return failure('UNAVAILABLE', 'Interactive browser control is unavailable.');
    }
    try {
      const scope = await this.scopeFor(request.sessionId, active);
      if (!scope) return failure('NOT_AUTHORIZED', 'Browser ownership is unavailable.');
      const running = this.activeOperations.get(scope);
      if (
        running &&
        request.operation === 'take' &&
        !running.intervention &&
        this.sessions.get(scope)?.fenceAgent
      ) {
        if (!(await this.canView(request.sessionId, scope, active)))
          return failure('NOT_AUTHORIZED', 'Browser ownership is unavailable.');
        const session = this.sessions.get(scope);
        const bound = await this.options.store.binding(scope);
        if (
          !session ||
          !session.fenceAgent ||
          bound?.status !== 'active' ||
          bound.owner !== this.options.owner ||
          bound.generation !== session.generation ||
          this.activeOperations.get(scope) !== running ||
          running.signal.aborted
        )
          return failure('BUSY', 'The browser operation is not ready for human intervention.');
        if (!running.intervention) {
          if (!session.fenceAgent())
            return failure('BUSY', 'The browser operation is not ready for human intervention.');
          let resolve!: () => void;
          const released = new Promise<void>((done) => {
            resolve = done;
          });
          activated = {
            settled: false,
            closed: false,
            released,
            release: () => {
              if (!activated || activated.closed) return;
              activated.closed = true;
              resolve();
            },
          };
          running.intervention = activated;
        }
      }
      const intervention = running?.intervention?.closed ? undefined : running?.intervention;
      const viewingSession = this.sessions.get(scope);
      if (request.operation === 'frame' && viewingSession?.readOnlyFrame && !intervention) {
        if (!(await this.canView(request.sessionId, scope, active)))
          return failure('NOT_AUTHORIZED', 'Browser ownership is unavailable.');
        const record = await this.options.interactionStore.get(scope);
        if (record?.mode !== 'human')
          return await this.options.store.run(
            `desktop:${scope}`,
            (lockSignal) =>
              this.readOnlyFrame(
                request,
                scope,
                viewingSession,
                AbortSignal.any([active, lockSignal]),
              ),
            active,
          );
        if (record.controllerId !== request.viewId)
          return failure('NOT_CONTROLLER', 'Another view controls this browser.', record);
      }
      if (['state', 'frame'].includes(request.operation) && running && !intervention) {
        if (!(await this.canView(request.sessionId, scope, active)))
          return failure('NOT_AUTHORIZED', 'Browser ownership is unavailable.');
        const record = await this.options.interactionStore.get(scope);
        const state = record
          ? this.controlState(record, request.viewId)
          : {
              ...this.controlState(),
              available: true,
              mode: 'agent' as const,
              generation: this.sessions.get(scope)?.generation ?? null,
            };
        return {
          state,
          error: { code: 'BUSY', message: 'Agent is working. Waiting for a fresh picture…' },
        };
      }
      return await this.options.store.run(
        intervention ? `desktop:${scope}` : scope,
        async (lockSignal) => {
          admitted = true;
          signal?.throwIfAborted();
          const operationSignal = AbortSignal.any([
            active,
            lockSignal,
            ...(intervention && running ? [running.signal] : []),
          ]);
          operationSignal.throwIfAborted();
          if (!(await this.canView(request.sessionId, scope, operationSignal)))
            return failure('NOT_AUTHORIZED', 'Browser ownership is unavailable.');
          let session = this.sessions.get(scope);
          let record = await this.control(scope);
          const bound = await this.options.store.binding(scope);
          if (!session && bound?.status === 'active')
            return failure(
              'BUSY',
              'The browser is still bound to a previous runtime. Administrator recovery must confirm that its browser processes have stopped before starting it again.',
            );
          if (request.operation === 'reset') {
            if (record?.mode === 'human' && record.controllerId !== request.viewId)
              return failure('NOT_CONTROLLER', 'Another view controls this browser.', record);
            await this.destroy(scope);
            if (record) {
              record = {
                ...record,
                mode: 'paused',
                epoch: record.epoch + 1,
                controllerId: null,
                expiresAt: null,
                frame: null,
                frames: [],
                keyboard: null,
                needsObservation: true,
                observedSessions: [],
              };
              await this.options.interactionStore!.put(record);
              await this.controlEvent(record, request.sessionId);
            }
            intervention?.release();
            return { state: this.controlState() };
          }
          if (
            session &&
            (bound?.generation !== session.generation ||
              bound.status !== 'active' ||
              this.stopping.has(session))
          )
            return failure('UNAVAILABLE', 'Browser binding is no longer available.');
          if (!session && request.operation === 'take') {
            if (
              bound?.status === 'active' ||
              this.sessions.size + this.allocating >= this.options.maxSessions
            )
              return failure('BUSY', 'Browser is busy or its previous owner has not stopped.');
            this.allocating++;
            try {
              session = await this.options.create(
                {
                  sessionId: scope,
                  callId: `human-${randomUUID()}`,
                  args: { operation: 'read_page', filter: 'all' },
                  permissionGranted: false,
                },
                operationSignal,
              );
              try {
                await this.options.store.bind({
                  sessionId: scope,
                  generation: session.generation,
                  owner: this.options.owner,
                  status: 'active',
                });
                this.sessions.set(scope, session);
              } catch (error) {
                await session.dispose();
                throw error;
              }
            } finally {
              this.allocating--;
            }
          }
          if (!session?.humanFrame || !session.humanInput)
            return failure('UNAVAILABLE', 'No interactive managed browser is active.');
          if (!record || record.generation !== session.generation) {
            record = {
              sessionId: scope,
              generation: session.generation,
              epoch: (record?.epoch ?? 0) + 1,
              mode: 'agent',
              controllerId: null,
              expiresAt: null,
              sequence: 0,
              frame: null,
              frames: [],
              keyboard: null,
              needsObservation: false,
              observedSessions: [],
            };
            await this.options.interactionStore!.put(record);
          }
          const fail = (
            code: NonNullable<BrowserInteractionResult['error']>['code'],
            message: string,
          ): BrowserInteractionResult => failure(code, message, record);
          if (
            'generation' in request &&
            (request.generation !== record.generation || request.epoch !== record.epoch)
          )
            return fail('STALE_CONTROL', 'Browser control changed. Refresh before sending input.');
          const controls = record.mode === 'human' && record.controllerId === request.viewId;
          if (request.operation === 'take') {
            if (record.mode === 'human' && !controls)
              return fail('NOT_CONTROLLER', 'Another view already controls this browser.');
            this.idle.get(scope)?.abort();
            this.idle.delete(scope);
            record = {
              ...record,
              mode: 'human',
              controllerId: request.viewId,
              epoch: controls ? record.epoch : record.epoch + 1,
              expiresAt: new Date(this.now().getTime() + 15_000).toISOString(),
              frame: null,
              frames: [],
              keyboard: null,
            };
            await this.options.interactionStore!.put(record);
            takeCommitted = true;
            await this.controlEvent(record, request.sessionId);
            this.armLease(record);
          } else if (request.operation === 'heartbeat') {
            if (!controls) return fail('NOT_CONTROLLER', 'This view does not control the browser.');
            record.expiresAt = new Date(this.now().getTime() + 15_000).toISOString();
            await this.options.interactionStore!.put(record);
          } else if (request.operation === 'pause' || request.operation === 'release') {
            if (record.mode === 'human' && !controls)
              return fail('NOT_CONTROLLER', 'This view does not control the browser.');
            if (request.operation === 'release') {
              if (intervention && !intervention.settled)
                return fail('BUSY', 'The earlier browser operation is still settling.');
              const observed = session.humanHandoff
                ? await session.humanHandoff(operationSignal)
                : await session.humanFrame(false, operationSignal);
              if (observed.preview.state !== 'frame' && observed.handoff !== 'navigation_only')
                return fail(
                  observed.preview.state === 'privacy_blocked' ? 'PRIVACY_BLOCKED' : 'BUSY',
                  'The browser must have a fresh non-private view before returning control.',
                );
            }
            record = {
              ...record,
              mode: request.operation === 'release' ? 'agent' : 'paused',
              controllerId: null,
              expiresAt: null,
              epoch: record.epoch + 1,
              frame: null,
              frames: [],
              keyboard: null,
              needsObservation: true,
              observedSessions: [],
            };
            await this.options.interactionStore!.put(record);
            await this.controlEvent(record, request.sessionId);
            this.armLease(record);
            this.armIdle(scope);
            if (intervention?.settled) intervention.release();
          } else if (request.operation === 'input') {
            if (!controls) return fail('NOT_CONTROLLER', 'Take control before sending input.');
            const previous = await this.options.interactionStore!.input(scope, request.requestId);
            if (previous) {
              if (
                (previous.sourceSessionId !== undefined &&
                  previous.sourceSessionId !== request.sessionId) ||
                previous.generation !== record.generation ||
                previous.epoch !== record.epoch ||
                previous.viewId !== request.viewId ||
                previous.sequence !== request.sequence
              )
                return fail(
                  'INPUT_SEQUENCE',
                  'This input identifier belongs to an earlier control sequence.',
                );
              if (previous.effect === 'unknown')
                return fail(
                  'UNKNOWN_EFFECT',
                  'The earlier input outcome is unknown. Inspect the browser; do not repeat it.',
                );
              return {
                state: this.controlState(record, request.viewId),
                input: { requestId: request.requestId, effect: previous.effect },
              };
            }
            if (request.sequence !== record.sequence + 1)
              return fail(
                'INPUT_SEQUENCE',
                'Input sequence is stale or out of order. Refresh the browser.',
              );
            const recovery =
              request.action.type === 'new_tab' && !request.frameId && !request.keyboardId;
            const target = recovery
              ? { recovery: 'new_tab' as const }
              : request.keyboardId
                ? (request.action.type === 'text' || request.action.type === 'key') &&
                  record.keyboard?.id === request.keyboardId
                  ? record.keyboard.target
                  : undefined
                : (record.frames.find((frame) => frame.frameId === request.frameId) ??
                  (record.frame?.frameId === request.frameId ? record.frame : undefined));
            if (
              !target ||
              ('capturedAt' in target &&
                this.now().getTime() - Date.parse(target.capturedAt) > 5_000)
            )
              return fail('STALE_FRAME', 'The picture is stale. Refresh before sending input.');
            record = {
              ...record,
              sequence: request.sequence,
              frame: null,
              frames: [],
              keyboard: null,
              expiresAt: new Date(this.now().getTime() + 15_000).toISOString(),
              needsObservation: true,
              observedSessions: [],
            };
            await this.options.interactionStore!.reserve(
              { ...record, mode: 'quarantined' },
              request.requestId,
              request.sessionId,
            );
            try {
              if (!(await this.canView(request.sessionId, scope, operationSignal))) {
                record = {
                  ...record,
                  mode: 'paused',
                  epoch: record.epoch + 1,
                  controllerId: null,
                  expiresAt: null,
                };
                await this.options.interactionStore!.finish(scope, request.requestId, 'none');
                await this.options.interactionStore!.put(record);
                await this.controlEvent(record);
                this.armLease(record);
                this.armIdle(scope);
                if (intervention?.settled) intervention.release();
                return failure('NOT_AUTHORIZED', 'Browser ownership changed before input.');
              }
              const outcome = await session.humanInput(request.action, target, operationSignal);
              if (outcome?.effect === 'none') {
                await this.options.interactionStore!.finish(scope, request.requestId, 'none');
                await this.options.interactionStore!.put(record);
                return {
                  ...fail(
                    'STALE_FRAME',
                    'Browser focus or page changed. Inspect a fresh picture before continuing.',
                  ),
                  input: { requestId: request.requestId, effect: 'none' },
                };
              }
              if (outcome?.effect === 'applied' && outcome.keyboard)
                record.keyboard = {
                  id: randomUUID(),
                  target: outcome.keyboard,
                };
              await this.options.events?.append(request.sessionId, [
                {
                  type: 'browser/user_input',
                  eventId: randomUUID(),
                  at: this.now().toISOString(),
                  generation: record.generation,
                  epoch: record.epoch,
                  requestId: request.requestId,
                  effect: 'applied',
                },
              ]);
              await this.options.interactionStore!.finish(scope, request.requestId, 'applied');
              await this.options.interactionStore!.put(record);
            } catch {
              const inputEpoch = record.epoch;
              record = {
                ...record,
                mode: 'quarantined',
                epoch: record.epoch + 1,
                controllerId: null,
                expiresAt: null,
                frame: null,
                frames: [],
                keyboard: null,
              };
              await this.options.interactionStore!.put(record);
              await this.options.events?.append(request.sessionId, [
                {
                  type: 'browser/user_input',
                  eventId: randomUUID(),
                  at: this.now().toISOString(),
                  generation: record.generation,
                  epoch: inputEpoch,
                  requestId: request.requestId,
                  effect: 'unknown',
                },
              ]);
              await this.controlEvent(record, request.sessionId);
              this.armLease(record);
              this.armIdle(scope);
              return fail(
                'UNKNOWN_EFFECT',
                'Input outcome is unknown. Take control again to inspect the browser; do not automatically repeat the input.',
              );
            }
          }
          if (!(await this.canView(request.sessionId, scope, operationSignal)))
            return failure('NOT_AUTHORIZED', 'Browser ownership changed.');
          if (request.operation === 'input' && request.capture === false)
            return {
              state: this.controlState(record, request.viewId),
              input: { requestId: request.requestId, effect: 'applied' },
              ...(record.keyboard ? { keyboardId: record.keyboard.id } : {}),
            };
          if (['frame', 'take', 'input'].includes(request.operation)) {
            const privateView = record.mode === 'human' && record.controllerId === request.viewId;
            if (intervention && !privateView)
              return fail('BUSY', 'The desktop is available only to its controlling view.');
            if (privateView)
              record.expiresAt = new Date(this.now().getTime() + 15_000).toISOString();
            const captured = await session.humanFrame(privateView, operationSignal);
            if (captured.preview.state !== 'frame') {
              // Keep the controlling view's lease alive even while capture is
              // unavailable, so explicit recovery does not lose its authority.
              if (privateView) {
                if (captured.preview.state !== 'busy') {
                  record.frame = null;
                  record.frames = [];
                  record.keyboard = null;
                }
                await this.options.interactionStore!.put(record);
              }
              return fail(
                captured.preview.state === 'privacy_blocked'
                  ? 'PRIVACY_BLOCKED'
                  : captured.preview.state === 'busy'
                    ? 'BUSY'
                    : 'UNAVAILABLE',
                captured.unavailableReason === 'viewport_size'
                  ? 'The page viewport exceeds the picture size limit. Open a new tab or restart the browser to recover.'
                  : captured.unavailableReason === 'image_geometry'
                    ? 'The browser picture does not match the page viewport. Open a new tab or restart the browser to recover.'
                    : 'A fresh browser picture is unavailable.',
              );
            }
            if (
              captured.preview.generation !== record.generation ||
              (captured.target &&
                (captured.target.width !== captured.preview.width ||
                  captured.target.height !== captured.preview.height))
            )
              return fail('UNAVAILABLE', 'Browser picture binding changed. Refresh the browser.');
            const frameId = randomUUID();
            if (privateView && captured.target) {
              record.frame = { ...captured.target, frameId };
              record.frames = [...record.frames, record.frame].slice(-8);
              await this.options.interactionStore!.put(record);
            }
            if (signal?.aborted) {
              if (record.mode === 'human' && record.controllerId === request.viewId) {
                record = {
                  ...record,
                  mode: 'paused',
                  epoch: record.epoch + 1,
                  controllerId: null,
                  expiresAt: null,
                  frame: null,
                  frames: [],
                  keyboard: null,
                };
                await this.options.interactionStore!.put(record);
                await this.controlEvent(record, request.sessionId);
                this.armLease(record);
                this.armIdle(scope);
                if (intervention?.settled) intervention.release();
              }
              return { state: this.controlState(record, request.viewId) };
            }
            if (!(await this.canView(request.sessionId, scope, operationSignal)))
              return failure('NOT_AUTHORIZED', 'Browser ownership changed.');
            return {
              state: this.controlState(record, request.viewId),
              frame: {
                ...captured.preview,
                frameId,
                epoch: record.epoch,
                ...(privateView && captured.surface ? { surface: captured.surface } : {}),
                ...(privateView && captured.browser ? { browser: captured.browser } : {}),
              },
              ...(privateView && record.keyboard ? { keyboardId: record.keyboard.id } : {}),
              ...(request.operation === 'input'
                ? { input: { requestId: request.requestId, effect: 'applied' as const } }
                : {}),
            };
          }
          return { state: this.controlState(record, request.viewId) };
        },
        active,
      );
    } catch {
      activated?.release();
      // A failed read/operation does not prove Chrome stopped or control was released.
      // Let the HTTP boundary report an outage so the viewer refreshes state instead
      // of alternating between a fabricated inactive state and the durable lease.
      throw new BrowserDriverError('DRIVER_FAILED', 'Managed browser interaction is unavailable.');
    } finally {
      if (activated && !takeCommitted) activated.release();
      signal?.removeEventListener('abort', disconnect);
    }
  }
  private async readOnlyFrame(
    request: BrowserInteractionRequest,
    scope: string,
    session: ManagedBrowserSession,
    signal: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    const before = await this.options.interactionStore!.get(scope);
    const state = (record: BrowserControlRecord | null): BrowserControlState =>
      record
        ? this.controlState(record, request.viewId)
        : {
            ...this.controlState(),
            available: true,
            mode: 'agent',
            generation: session.generation,
          };
    const failure = (
      code: NonNullable<BrowserInteractionResult['error']>['code'],
      message: string,
    ): BrowserInteractionResult => ({ state: state(before), error: { code, message } });
    const valid = async (): Promise<boolean> => {
      const binding = await this.options.store.binding(scope);
      return (
        (await this.canView(request.sessionId, scope, signal)) &&
        this.sessions.get(scope) === session &&
        !this.stopping.has(session) &&
        binding?.status === 'active' &&
        binding.owner === this.options.owner &&
        binding.generation === session.generation
      );
    };
    if (!(await valid()))
      return {
        state: this.controlState(),
        error: { code: 'NOT_AUTHORIZED', message: 'Browser ownership is unavailable.' },
      };
    if (before?.mode === 'human')
      return failure('NOT_CONTROLLER', 'Another view controls this browser.');
    if (before && before.generation !== session.generation)
      return failure('UNAVAILABLE', 'Browser picture binding changed. Refresh the browser.');
    const preview = browserPreviewSchema.parse(await session.readOnlyFrame!(signal));
    const after = await this.options.interactionStore!.get(scope);
    signal.throwIfAborted();
    if (!(await valid()))
      return {
        state: this.controlState(),
        error: { code: 'NOT_AUTHORIZED', message: 'Browser ownership changed.' },
      };
    if (
      after?.epoch !== before?.epoch ||
      after?.generation !== before?.generation ||
      after?.mode !== before?.mode ||
      after?.controllerId !== before?.controllerId
    )
      return {
        state: state(after),
        error: { code: 'BUSY', message: 'Browser control changed. Waiting for a fresh picture…' },
      };
    if (preview.state !== 'frame' || preview.generation !== session.generation)
      return failure('UNAVAILABLE', 'A fresh browser picture is unavailable.');
    return {
      state: state(after),
      frame: { ...preview, frameId: randomUUID(), epoch: after?.epoch ?? 0, surface: 'desktop' },
    };
  }
  private stop(session: ManagedBrowserSession): Promise<void> {
    let pending = this.stopping.get(session);
    if (!pending) {
      pending = session.dispose();
      this.stopping.set(session, pending);
    }
    return pending;
  }
  private async destroy(sessionId: string): Promise<void> {
    this.leases.get(sessionId)?.abort();
    this.leases.delete(sessionId);
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
    scope: string,
    operation: ActiveBrowserOperation,
  ): Promise<BrowserRuntimeResult> {
    active.throwIfAborted();
    if (
      !(await this.options.authorize(request, active)) ||
      (await this.scopeFor(request.sessionId, active)) !== scope
    ) {
      if (!this.options.scope) await this.destroy(scope);
      return browserRuntimeFailure(request, 'NOT_AUTHORIZED');
    }
    const control = await this.control(scope);
    if (control && control.mode !== 'agent')
      return {
        isError: true,
        value: {
          kind: 'browser-error-v1',
          operation: request.args.operation,
          code: 'NOT_EXECUTED',
          effect: 'none',
          message:
            'The user has taken or paused browser control. Wait for the user to return control before further browser operations.',
          recovery: 'conclude',
        },
      };
    if (
      control?.needsObservation &&
      !(this.options.scope && control.observedSessions.includes(request.sessionId)) &&
      !['navigate', 'web_search', 'read_page', 'get_page_text', 'screenshot'].includes(
        request.args.operation,
      )
    )
      return {
        isError: true,
        value: {
          kind: 'browser-error-v1',
          operation: request.args.operation,
          code: 'STALE_TARGET',
          effect: 'none',
          message:
            'The user changed the browser. Read the current page or capture a fresh screenshot before using prior page targets. Explicit navigation or web search can obtain a new observation.',
          recovery: 'reobserve',
        },
      };
    const hash = createHash('sha256').update(canonicalBrowserJson(request)).digest('hex');
    const previous = await this.options.store.command(request.sessionId, request.callId);
    if (previous) {
      if (previous.hash !== hash) return browserRuntimeFailure(request, 'NOT_AUTHORIZED');
      if (previous.result) return previous.result;
      await this.destroy(scope);
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    }
    this.idle.get(scope)?.abort();
    this.idle.delete(scope);
    let session = this.sessions.get(scope);
    const record = await this.options.store.binding(scope);
    if (session && this.stopping.has(session))
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    if (record?.status === 'active' && (record.owner !== this.options.owner || !session))
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    if (session && (record?.generation !== session.generation || record.status !== 'active')) {
      await this.destroy(scope);
      return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    }
    if (!session) {
      if (this.sessions.size + this.allocating >= this.options.maxSessions)
        return browserRuntimeFailure(request, 'NOT_EXECUTED');
      this.allocating++;
      try {
        session = await this.options.create({ ...request, sessionId: scope }, active);
        try {
          await this.options.store.bind({
            sessionId: scope,
            owner: this.options.owner,
            generation: session.generation,
            status: 'active',
          });
          this.sessions.set(scope, session);
        } catch (err) {
          await session.dispose();
          throw err;
        }
      } finally {
        this.allocating--;
      }
    }
    await this.options.store.begin(request.sessionId, request.callId, hash, session.generation);
    let result: BrowserRuntimeResult;
    try {
      result = browserRuntimeResultSchema.parse(await session.execute(request, active));
    } catch (error) {
      if (operation.intervention) {
        await this.settleIntervention(scope, operation.intervention, active);
      }
      throw error;
    }
    const intervention = operation.intervention;
    if (intervention) {
      await this.settleIntervention(scope, intervention, active);
      result = browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
    }
    active.throwIfAborted();
    await this.options.store.finish(request.sessionId, request.callId, result);
    if (!intervention && control?.needsObservation && !result.isError)
      await this.options.interactionStore!.put({
        ...control,
        needsObservation: !!this.options.scope,
        observedSessions: this.options.scope
          ? [
              ...control.observedSessions.filter((id) => id !== request.sessionId),
              request.sessionId,
            ].slice(-128)
          : [],
        frame: null,
        frames: [],
        keyboard: null,
      });
    active.throwIfAborted();
    const sourceDenied =
      this.options.scope &&
      result.value.kind === 'browser-error-v1' &&
      result.value.code === 'NOT_AUTHORIZED' &&
      result.value.effect === 'none';
    if (result.isError && !sourceDenied && !intervention) await this.destroy(scope);
    else if (this.sessions.get(scope) === session) this.armIdle(scope);
    return result;
  }
  private async settleIntervention(
    scope: string,
    intervention: BrowserIntervention,
    signal: AbortSignal,
  ): Promise<void> {
    intervention.settled = true;
    if (!intervention.closed)
      await this.options.store.run(
        `desktop:${scope}`,
        async () => {
          const record = await this.options.interactionStore?.get(scope);
          if (record?.mode === 'paused') intervention.release();
        },
        signal,
      );
    await intervention.released;
  }
  async execute(input: BrowserRuntimeRequest, signal?: AbortSignal): Promise<BrowserRuntimeResult> {
    const request = browserRuntimeRequestSchema.parse(input);
    const deadline = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(110_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const scope = await this.scopeFor(request.sessionId, deadline);
      if (!scope || !(await this.options.authorize(request, deadline)))
        return browserRuntimeFailure(request, 'NOT_AUTHORIZED');
      return await this.options.store.run(
        scope,
        async (lockSignal) => {
          const stop = new AbortController();
          const active = AbortSignal.any([deadline, lockSignal, stop.signal]);
          const operation: ActiveBrowserOperation = { stop, signal: active };
          this.activeOperations.set(scope, operation);
          const cancelIntervention = (): void => operation.intervention?.release();
          active.addEventListener('abort', cancelIntervention, { once: true });
          try {
            return await this.executeLocked(request, active, scope, operation);
          } catch (err) {
            await this.destroy(scope);
            throw err;
          } finally {
            active.removeEventListener('abort', cancelIntervention);
            this.activeOperations.delete(scope);
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
    let admitted = false;
    const disconnected = new AbortController();
    const disconnect = (): void => {
      if (!admitted) disconnected.abort();
    };
    signal?.addEventListener('abort', disconnect, { once: true });
    if (signal?.aborted) disconnect();
    const active = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(5000),
      disconnected.signal,
    ]);
    try {
      const scope = await this.scopeFor(sessionId, active);
      if (!scope || !(await this.canView(sessionId, scope, active)))
        return { state: 'unavailable' };
      // A spectator must not queue behind a long action or keep the idle lease alive.
      if (this.activeOperations.has(scope)) return { state: 'busy' };
      return await this.options.store.run(
        scope,
        async (lockSignal) => {
          admitted = true;
          signal?.throwIfAborted();
          const captureSignal = AbortSignal.any([active, lockSignal]);
          if (!(await this.canView(sessionId, scope, captureSignal)))
            return { state: 'unavailable' };
          const session = this.sessions.get(scope);
          const record = await this.options.store.binding(scope);
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
            signal?.aborted ||
            !(await this.canView(sessionId, scope, captureSignal)) ||
            (result.state === 'frame' && result.generation !== session.generation)
          )
            return { state: 'unavailable' };
          return result;
        },
        active,
      );
    } catch {
      return { state: signal?.aborted || this.shutdown.signal.aborted ? 'unavailable' : 'busy' };
    } finally {
      signal?.removeEventListener('abort', disconnect);
    }
  }
  async close(sessionId: string): Promise<void> {
    this.activeOperations.get(sessionId)?.stop.abort();
    await this.options.store.run(sessionId, async () => this.destroy(sessionId));
  }
}
