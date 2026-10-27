import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  browserControlRecordSchema,
  browserInteractionRequestSchema,
  type BrowserControlRecord,
  type BrowserInputRecord,
  type BrowserInteractionStore,
  type BrowserRuntimeStore,
  type BrowserRuntimeRecord,
  type BrowserRuntimeRequest,
  type BrowserRuntimeResult,
  type BrowserHumanCapture,
  type BrowserInteractionResult,
  type BrowserHumanInputResult,
  type ManagedBrowserSession,
} from '@trinity-harness/contracts';
import {
  ManagedBrowserSupervisor,
  MemorySessionStore,
  browserRuntimeFailure,
} from '../src/index.js';

const supervisors: ManagedBrowserSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.dispose()));
});
class Controls implements BrowserInteractionStore {
  records = new Map<string, BrowserControlRecord>();
  inputs = new Map<string, BrowserInputRecord>();
  async get(id: string): Promise<BrowserControlRecord | null> {
    const r = this.records.get(id);
    return r ? structuredClone(r) : null;
  }
  async put(record: BrowserControlRecord): Promise<void> {
    this.records.set(record.sessionId, browserControlRecordSchema.parse(structuredClone(record)));
  }
  async input(id: string, key: string): Promise<BrowserInputRecord | null> {
    return this.inputs.get(`${id}/${key}`) ?? null;
  }
  async reserve(
    record: BrowserControlRecord,
    key: string,
    sourceSessionId?: string,
  ): Promise<void> {
    if (this.inputs.has(`${record.sessionId}/${key}`)) throw Error('duplicate');
    await this.put(record);
    this.inputs.set(`${record.sessionId}/${key}`, {
      ...(sourceSessionId ? { sourceSessionId } : {}),
      generation: record.generation,
      epoch: record.epoch,
      viewId: record.controllerId!,
      sequence: record.sequence,
      effect: 'unknown',
    });
  }
  async finish(id: string, key: string, effect: 'applied' | 'none' | 'unknown'): Promise<void> {
    const r = this.inputs.get(`${id}/${key}`);
    if (!r) throw Error('unreserved');
    r.effect = effect;
  }
}
class Journal implements BrowserRuntimeStore {
  records = new Map<string, BrowserRuntimeRecord>();
  commands = new Map<string, { hash: string; result: BrowserRuntimeResult | null }>();
  tails = new Map<string, Promise<void>>();
  async run<T>(
    id: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let done!: () => void;
    this.tails.set(
      id,
      new Promise((resolve) => {
        done = resolve;
      }),
    );
    await previous;
    try {
      signal?.throwIfAborted();
      return await action(signal ?? new AbortController().signal);
    } finally {
      done();
    }
  }
  async binding(id: string): Promise<BrowserRuntimeRecord | null> {
    return this.records.get(id) ?? null;
  }
  async bind(r: BrowserRuntimeRecord): Promise<void> {
    this.records.set(r.sessionId, r);
  }
  async command(
    id: string,
    key: string,
  ): Promise<{ hash: string; result: BrowserRuntimeResult | null } | null> {
    return this.commands.get(`${id}/${key}`) ?? null;
  }
  async begin(id: string, key: string, hash: string): Promise<void> {
    this.commands.set(`${id}/${key}`, { hash, result: null });
  }
  async finish(id: string, key: string, result: BrowserRuntimeResult): Promise<void> {
    this.commands.get(`${id}/${key}`)!.result = result;
  }
}
function result(request: BrowserRuntimeRequest): BrowserRuntimeResult {
  return {
    isError: false,
    value: {
      kind: 'browser-result-v1',
      operation: request.args.operation,
      callId: request.callId,
      sessionId: request.sessionId,
      observationId: 'obs',
      artifactUri: `blob://browser/${request.sessionId}/obs.json`,
      url: 'https://example.com/',
      title: 'Fixture',
      capturedAt: '2026-10-26T00:00:00Z',
      bindingId: 'binding',
      tabId: 'tab',
      documentRevision: 'revision',
      readiness: 'ready',
      saved: false,
      securityMode: 'trusted-managed',
      captureTruncated: false,
      representation: 'article',
      scope: 'main',
      exclusions: [],
      publishedAt: null,
      outline: [],
      duplicateSuppressed: false,
      outputTruncated: false,
      blocks: [],
      receipt: [],
      continuation: null,
    },
  };
}
function setup(shared = false, desktop = false) {
  const sessionId = randomUUID(),
    sideId = randomUUID(),
    viewId = randomUUID(),
    generation = randomUUID();
  const controls = new Controls(),
    journal = new Journal(),
    events = new MemorySessionStore();
  let time = Date.parse('2026-10-26T00:00:00Z');
  let owner = true;
  const revokedSessions = new Set<string>();
  let privatePage = false;
  const humanInput = vi.fn(async (): Promise<BrowserHumanInputResult | void> => undefined),
    execute = vi.fn<
      (request: BrowserRuntimeRequest, signal: AbortSignal) => Promise<BrowserRuntimeResult>
    >(async (request) => result(request)),
    dispose = vi.fn(async () => undefined);
  const fenceAgent = vi.fn(() => true);
  const capture = vi.fn(async (privateView: boolean): Promise<BrowserHumanCapture> =>
    privatePage && !privateView
      ? { preview: { state: 'privacy_blocked' } }
      : {
          ...(desktop && privateView ? { surface: 'desktop' as const } : {}),
          preview: {
            state: 'frame',
            generation,
            capturedAt: new Date(time).toISOString(),
            securityMode: 'trusted-managed',
            width: 100,
            height: 80,
            png: 'aW1hZ2U=',
          },
          target: {
            tabId: 'tab',
            documentRevision: 'revision',
            fingerprint: 'a'.repeat(64),
            width: 100,
            height: 80,
            capturedAt: new Date(time).toISOString(),
          },
          browser: {
            tabs: [
              { id: 'tab', title: 'Private title', url: 'https://private.example/', active: true },
            ],
          },
        },
  );
  const create = vi.fn<
    (request: BrowserRuntimeRequest, signal: AbortSignal) => Promise<ManagedBrowserSession>
  >(async () => ({
    generation,
    execute,
    dispose,
    humanFrame: capture,
    humanInput,
    ...(desktop ? { fenceAgent } : {}),
  }));
  const supervisor = new ManagedBrowserSupervisor({
    store: journal,
    scope: shared
      ? { resolve: async (id) => (id === sessionId || id === sideId ? sessionId : null) }
      : undefined,
    interactionStore: controls,
    events,
    owner: randomUUID(),
    authorize: async (request) => owner && !revokedSessions.has(request.sessionId),
    authorizePreview: async (id) => owner && !revokedSessions.has(id),
    create,
    maxSessions: 2,
    idleMs: 300000,
    now: () => new Date(time),
  });
  supervisors.push(supervisor);
  const take = () => supervisor.interact({ sessionId, viewId, operation: 'take' });
  const model = (
    operation: 'navigate' | 'web_search' | 'read_page' | 'scroll' = 'navigate',
  ): BrowserRuntimeRequest => ({
    sessionId,
    callId: randomUUID(),
    args:
      operation === 'navigate'
        ? { operation, url: 'https://example.com/' }
        : operation === 'web_search'
          ? { operation, query: 'fixture source' }
          : operation === 'scroll'
            ? { operation, snapshotId: 'prior-snapshot', direction: 'down', pixels: 100 }
            : { operation, filter: 'all' },
    permissionGranted: false,
  });
  const input = (r: BrowserInteractionResult) => ({
    sessionId,
    viewId,
    operation: 'input' as const,
    generation: r.state.generation!,
    epoch: r.state.epoch,
    sequence: r.state.nextSequence,
    requestId: randomUUID(),
    frameId: r.frame!.frameId,
    action: { type: 'text' as const, text: 'private password value' },
  });
  return {
    sessionId,
    sideId,
    viewId,
    generation,
    controls,
    journal,
    events,
    humanInput,
    fenceAgent,
    execute,
    dispose,
    create,
    capture,
    supervisor,
    take,
    model,
    input,
    advance: (ms: number) => {
      time += ms;
    },
    revoke: () => {
      owner = false;
    },
    sensitive: () => {
      privatePage = true;
    },
    revokeSession: (id: string) => {
      revokedSessions.add(id);
    },
  };
}

it('fences a blocked agent call while the controlling user operates the desktop', async () => {
  const f = setup(false, true);
  const command = f.model();
  let finish!: (value: BrowserRuntimeResult) => void;
  f.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let agentReturned = false;
  const agent = f.supervisor.execute(command).then((value) => {
    agentReturned = true;
    return value;
  });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  const taken = await f.take();
  expect(taken.frame?.surface).toBe('desktop');
  expect(taken.state.mode).toBe('human');
  expect(f.fenceAgent).toHaveBeenCalledTimes(1);
  expect(agentReturned).toBe(false);
  const release = {
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'release' as const,
    generation: f.generation,
    epoch: taken.state.epoch,
  };
  expect((await f.supervisor.interact(release)).error?.code).toBe('BUSY');
  const spectator = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: randomUUID(),
    operation: 'frame',
  });
  expect(spectator.frame).toBeUndefined();
  expect(spectator.error?.code).toBe('BUSY');
  const request = f.input(taken);
  f.humanInput.mockImplementationOnce(async () => {
    finish(result(command));
    return { effect: 'applied' };
  });
  expect((await f.supervisor.interact(request)).input?.effect).toBe('applied');
  expect(f.humanInput).toHaveBeenCalledTimes(1);
  expect(agentReturned).toBe(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await f.supervisor.interact(release)).state.mode).toBe('agent');
  expect((await agent).value).toMatchObject({ kind: 'browser-error-v1', effect: 'unknown' });
  expect(f.dispose).not.toHaveBeenCalled();
  expect((await f.controls.get(f.sessionId))?.needsObservation).toBe(true);
});

it('quarantines an uncertain desktop input during intervention and never repeats it', async () => {
  const f = setup(false, true);
  const command = f.model();
  let finish!: (value: BrowserRuntimeResult) => void;
  f.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const agent = f.supervisor.execute(command);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  const taken = await f.take();
  const input = f.input(taken);
  f.humanInput.mockRejectedValueOnce(new Error('desktop disconnected'));
  expect((await f.supervisor.interact(input)).state.mode).toBe('quarantined');
  const again = await f.take();
  expect(again.state.mode).toBe('human');
  expect(
    (
      await f.supervisor.interact({
        ...input,
        generation: again.state.generation!,
        epoch: again.state.epoch,
      })
    ).error?.code,
  ).toBe('INPUT_SEQUENCE');
  expect(f.humanInput).toHaveBeenCalledTimes(1);
  finish(result(command));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(
    (
      await f.supervisor.interact({
        sessionId: f.sessionId,
        viewId: f.viewId,
        operation: 'release',
        generation: f.generation,
        epoch: again.state.epoch,
      })
    ).state.mode,
  ).toBe('agent');
  expect((await agent).value).toMatchObject({ effect: 'unknown' });
});

it('pauses expired intervention control and resolves the agent call only after it settles', async () => {
  const f = setup(false, true);
  const command = f.model();
  let finish!: (value: BrowserRuntimeResult) => void;
  f.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const agent = f.supervisor.execute(command);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  await f.take();
  f.advance(15_001);
  expect(
    (await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'state' }))
      .state.mode,
  ).toBe('paused');
  finish(result(command));
  expect((await agent).value).toMatchObject({ effect: 'unknown' });
  expect((await f.controls.get(f.sessionId))?.mode).toBe('paused');
  expect((await f.supervisor.execute(f.model())).value).toMatchObject({
    code: 'NOT_EXECUTED',
    effect: 'none',
  });
});

it('stops and disposes a blocked intervention when the agent operation is cancelled', async () => {
  const f = setup(false, true);
  const cancel = new AbortController();
  f.execute.mockImplementationOnce(
    async (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  );
  const agent = f.supervisor.execute(f.model(), cancel.signal);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  await f.take();
  cancel.abort();
  expect((await agent).value).toMatchObject({ effect: 'unknown' });
  expect(f.dispose).toHaveBeenCalledTimes(1);
});
it('shares one browser between Main and side viewers while retaining the originating input event', async () => {
  const f = setup(true);
  const taken = await f.supervisor.interact({
    sessionId: f.sideId,
    viewId: f.viewId,
    operation: 'take',
  });
  expect(taken.frame).toBeDefined();
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({ sessionId: f.sessionId });
  const main = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: randomUUID(),
    operation: 'state',
  });
  expect(main.state).toMatchObject({
    available: true,
    generation: taken.state.generation,
    mode: 'human',
    controllerId: null,
  });
  const applied = await f.supervisor.interact({ ...f.input(taken), sessionId: f.sideId });
  expect(applied.input?.effect).toBe('applied');
  expect((await f.controls.input(f.sessionId, applied.input!.requestId))?.sourceSessionId).toBe(
    f.sideId,
  );
  expect(f.controls.records.has(f.sideId)).toBe(false);
  expect((await f.events.load(f.sideId)).some((event) => event.type === 'browser/user_input')).toBe(
    true,
  );
  expect(
    (await f.events.load(f.sessionId)).some((event) => event.type === 'browser/user_input'),
  ).toBe(false);
  await f.supervisor.interact({
    sessionId: f.sideId,
    viewId: f.viewId,
    operation: 'pause',
    generation: taken.state.generation!,
    epoch: taken.state.epoch,
  });
  expect((await f.take()).frame).toBeDefined();
  expect(f.create).toHaveBeenCalledTimes(1);
});

it('enforces shared human control and per-chat observation fences after return to the agent', async () => {
  const f = setup(true);
  const taken = await f.take();
  const side = (operation: Parameters<typeof f.model>[0] = 'navigate') => ({
    ...f.model(operation),
    sessionId: f.sideId,
  });
  expect((await f.supervisor.execute(side())).value).toMatchObject({ code: 'NOT_EXECUTED' });
  expect(f.execute).not.toHaveBeenCalled();
  await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'release',
    generation: taken.state.generation!,
    epoch: taken.state.epoch,
  });
  expect((await f.supervisor.execute(f.model('read_page'))).isError).toBe(false);
  expect((await f.supervisor.execute(side('scroll'))).value).toMatchObject({
    code: 'STALE_TARGET',
  });
  const read = side('read_page');
  expect((await f.supervisor.execute(read)).value).toMatchObject({
    sessionId: f.sideId,
    callId: read.callId,
  });
  expect((await f.supervisor.execute(side('scroll'))).isError).toBe(false);
  expect(f.journal.commands.has(`${f.sideId}/${read.callId}`)).toBe(true);
  expect(f.journal.commands.has(`${f.sessionId}/${read.callId}`)).toBe(false);
  expect(f.create).toHaveBeenCalledTimes(1);
  // A later human edit invalidates each chat's prior observation receipt.
  const again = await f.take();
  await f.supervisor.interact(f.input(again));
  await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'release',
    generation: again.state.generation!,
    epoch: again.state.epoch,
  });
  expect((await f.supervisor.execute(side('scroll'))).value).toMatchObject({
    code: 'STALE_TARGET',
  });
});

it('does not dispose the shared browser when a side chat closes or an unrelated caller is denied', async () => {
  const f = setup(true);
  await f.take();
  await f.supervisor.close(f.sideId);
  expect(f.dispose).not.toHaveBeenCalled();
  expect(
    (
      await f.supervisor.interact({
        sessionId: randomUUID(),
        viewId: randomUUID(),
        operation: 'take',
      })
    ).error?.code,
  ).toBe('NOT_AUTHORIZED');
  expect(
    (await f.supervisor.execute({ ...f.model(), sessionId: randomUUID() })).value,
  ).toMatchObject({ code: 'NOT_AUTHORIZED' });
  expect(f.dispose).not.toHaveBeenCalled();
  expect(
    (await f.supervisor.interact({ sessionId: f.sideId, viewId: f.viewId, operation: 'frame' }))
      .frame,
  ).toBeDefined();
  await f.supervisor.close(f.sessionId);
  expect(f.dispose).toHaveBeenCalledTimes(1);
});

it('serializes side model work and Main takeover under the same durable browser lock', async () => {
  const f = setup(true);
  let entered!: () => void, complete!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.execute.mockImplementationOnce(async (request) => {
    entered();
    await held;
    return result(request);
  });
  const model = f.supervisor.execute({ ...f.model(), sessionId: f.sideId });
  await started;
  const busy = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'frame',
  });
  expect(busy.error?.code).toBe('BUSY');
  let taken = false;
  const takeover = f.take().then((r) => {
    taken = true;
    return r;
  });
  await Promise.resolve();
  expect(taken).toBe(false);
  complete();
  expect((await model).isError).toBe(false);
  expect((await takeover).state.mode).toBe('human');
  expect(f.create).toHaveBeenCalledTimes(1);
});

it('rechecks the originating side chat after reserving an input and before effects', async () => {
  const f = setup(true);
  const taken = await f.supervisor.interact({
    sessionId: f.sideId,
    viewId: f.viewId,
    operation: 'take',
  });
  const input = { ...f.input(taken), sessionId: f.sideId };
  const reserve = f.controls.reserve.bind(f.controls);
  vi.spyOn(f.controls, 'reserve').mockImplementationOnce(async (record, key, source) => {
    await reserve(record, key, source);
    f.revokeSession(f.sideId);
  });
  expect((await f.supervisor.interact(input)).error?.code).toBe('NOT_AUTHORIZED');
  expect(f.humanInput).not.toHaveBeenCalled();
  expect((await f.controls.input(f.sessionId, input.requestId))?.effect).toBe('none');
  expect((await f.controls.get(f.sessionId))?.mode).toBe('paused');
  expect(f.dispose).not.toHaveBeenCalled();
  expect((await f.take()).frame).toBeDefined();
});

it('keeps identical tool call IDs separate across originating chats sharing one browser', async () => {
  const f = setup(true);
  const main = { ...f.model(), callId: 'same-call' };
  const side = { ...main, sessionId: f.sideId };
  expect((await f.supervisor.execute(main)).value).toMatchObject({ sessionId: f.sessionId });
  expect((await f.supervisor.execute(side)).value).toMatchObject({ sessionId: f.sideId });
  expect((await f.supervisor.execute(side)).value).toMatchObject({ sessionId: f.sideId });
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.journal.commands.size).toBe(2);
});

it('does not replay a shared input receipt under a different originating chat', async () => {
  const f = setup(true);
  const taken = await f.supervisor.interact({
    sessionId: f.sideId,
    viewId: f.viewId,
    operation: 'take',
  });
  const input = { ...f.input(taken), sessionId: f.sideId };
  expect((await f.supervisor.interact(input)).input?.effect).toBe('applied');
  expect((await f.supervisor.interact({ ...input, sessionId: f.sessionId })).error?.code).toBe(
    'INPUT_SEQUENCE',
  );
  expect(f.humanInput).toHaveBeenCalledTimes(1);
});

it('keeps the shared browser when a side tool loses authorization before any effect', async () => {
  const f = setup(true);
  const side = { ...f.model(), sessionId: f.sideId };
  f.execute.mockResolvedValueOnce(browserRuntimeFailure(side, 'NOT_AUTHORIZED'));
  expect((await f.supervisor.execute(side)).value).toMatchObject({
    code: 'NOT_AUTHORIZED',
    effect: 'none',
  });
  expect(f.dispose).not.toHaveBeenCalled();
  expect((await f.supervisor.execute(f.model())).isError).toBe(false);
  expect(f.create).toHaveBeenCalledTimes(1);
});
it.each([
  { type: 'new_tab' },
  { type: 'open_browser_page', page: 'bookmarks' },
  { type: 'open_browser_page', page: 'account' },
] as const)('keeps viewer metadata private when applying %j', async (action) => {
  const f = setup();
  const taken = await f.take();
  expect(taken.frame?.browser?.tabs[0]?.title).toBe('Private title');
  const other = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: randomUUID(),
    operation: 'frame',
  });
  expect(other.frame?.browser).toBeUndefined();
  const input = { ...f.input(taken), action };
  const applied = await f.supervisor.interact(input);
  expect(applied.input?.effect).toBe('applied');
  expect(applied.frame?.browser?.tabs[0]?.title).toBe('Private title');
  const persisted = JSON.stringify({
    controls: [...f.controls.records.values()],
    inputs: [...f.controls.inputs.values()],
    events: await f.events.load(f.sessionId),
  });
  expect(persisted).not.toContain('Private title');
  expect(persisted).not.toContain('private.example');
  await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'release',
    generation: taken.state.generation!,
    epoch: taken.state.epoch,
  });
  expect(
    (await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'frame' }))
      .frame?.browser,
  ).toBeUndefined();
});
it('does not allocate a browser for viewing, denies nonowners and permits one controlling view', async () => {
  const f = setup();
  expect(
    (await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'frame' }))
      .state.available,
  ).toBe(false);
  expect(f.create).not.toHaveBeenCalled();
  const taken = await f.take();
  expect(taken.state.mode).toBe('human');
  expect(taken.frame).toBeDefined();
  expect(
    (
      await f.supervisor.interact({
        sessionId: f.sessionId,
        viewId: randomUUID(),
        operation: 'take',
      })
    ).error?.code,
  ).toBe('NOT_CONTROLLER');
  f.revoke();
  expect((await f.take()).error?.code).toBe('NOT_AUTHORIZED');
  expect(f.create).toHaveBeenCalledTimes(1);
});
it('drains an in-flight model operation before acknowledging takeover and blocks subsequent model calls', async () => {
  const f = setup();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    block = new Promise<void>((r) => {
      finish = r;
    });
  f.execute.mockImplementationOnce(async (request) => {
    entered();
    await block;
    return result(request);
  });
  const model = f.supervisor.execute(f.model());
  await started;
  let acknowledged = false;
  const take = f.take().then((r) => {
    acknowledged = true;
    return r;
  });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  finish();
  await model;
  expect((await take).state.mode).toBe('human');
  expect((await f.supervisor.execute(f.model())).value).toMatchObject({
    code: 'NOT_EXECUTED',
    effect: 'none',
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('fences stale generation, epoch, sequence and screenshot without sending an input', async () => {
  const f = setup(),
    taken = await f.take(),
    input = f.input(taken);
  for (const patch of [{ generation: randomUUID() }, { epoch: input.epoch + 1 }])
    expect((await f.supervisor.interact({ ...input, ...patch })).error?.code).toBe('STALE_CONTROL');
  expect((await f.supervisor.interact({ ...input, sequence: 2 })).error?.code).toBe(
    'INPUT_SEQUENCE',
  );
  expect((await f.supervisor.interact({ ...input, frameId: randomUUID() })).error?.code).toBe(
    'STALE_FRAME',
  );
  f.advance(5001);
  expect((await f.supervisor.interact(input)).error?.code).toBe('STALE_FRAME');
  expect(f.humanInput).not.toHaveBeenCalled();
});
it('accepts a recently displayed frame across polling, journals before effects and never stores typed values', async () => {
  const f = setup(),
    taken = await f.take(),
    input = f.input(taken);
  await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'frame' });
  f.humanInput.mockImplementationOnce(async () => {
    expect((await f.controls.input(f.sessionId, input.requestId))?.effect).toBe('unknown');
    expect((await f.controls.get(f.sessionId))?.mode).toBe('quarantined');
  });
  expect((await f.supervisor.interact(input)).input?.effect).toBe('applied');
  expect((await f.supervisor.interact(input)).input?.effect).toBe('applied');
  expect(f.humanInput).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify([
      await f.events.load(f.sessionId),
      [...f.controls.records.values()],
      [...f.controls.inputs.values()],
    ]),
  ).not.toContain('private password value');
});
it('pauses expired control without automatically returning it to the agent', async () => {
  const f = setup();
  await f.take();
  f.advance(15001);
  expect(
    (await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'state' }))
      .state.mode,
  ).toBe('paused');
  expect((await f.supervisor.execute(f.model())).value).toMatchObject({ code: 'NOT_EXECUTED' });
});
it('requires a privacy-safe return and a new model observation before subsequent effects', async () => {
  const f = setup(),
    taken = await f.take();
  f.sensitive();
  const release = {
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'release' as const,
    generation: f.generation,
    epoch: taken.state.epoch,
  };
  expect((await f.supervisor.interact(release)).error?.code).toBe('PRIVACY_BLOCKED');
  f.capture.mockImplementation(async () => ({
    preview: {
      state: 'frame',
      generation: f.generation,
      capturedAt: '2026-10-26T00:00:00Z',
      securityMode: 'trusted-managed',
      width: 100,
      height: 80,
      png: 'aW1hZ2U=',
    },
  }));
  expect((await f.supervisor.interact(release)).state.mode).toBe('agent');
  expect((await f.supervisor.execute(f.model('scroll'))).value).toMatchObject({
    code: 'STALE_TARGET',
  });
  expect((await f.supervisor.execute(f.model('read_page'))).isError).toBe(false);
  expect((await f.supervisor.execute(f.model())).isError).toBe(false);
});
it.each(['navigate', 'web_search'] as const)(
  'allows %s to capture fresh evidence after human return, including after browser disposal',
  async (operation) => {
    const f = setup(),
      taken = await f.take();
    await f.supervisor.interact({
      sessionId: f.sessionId,
      viewId: f.viewId,
      operation: 'release',
      generation: f.generation,
      epoch: taken.state.epoch,
    });
    expect((await f.controls.get(f.sessionId))?.needsObservation).toBe(true);
    // Simulate the expired runtime binding while retaining durable handoff state.
    await f.supervisor.dispose();
    const resumed = new ManagedBrowserSupervisor({
      store: f.journal,
      interactionStore: f.controls,
      events: f.events,
      owner: randomUUID(),
      authorize: async () => true,
      authorizePreview: async () => true,
      create: f.create,
      maxSessions: 2,
      idleMs: 300000,
    });
    supervisors.push(resumed);
    const request = f.model(operation);
    expect((await resumed.execute(request)).isError).toBe(false);
    expect(f.execute).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect((await f.controls.get(f.sessionId))?.needsObservation).toBe(false);
    expect((await resumed.execute(f.model('web_search'))).isError).toBe(false);
  },
);
it('retains the fresh-observation fence when a permitted navigation fails', async () => {
  const f = setup(),
    taken = await f.take();
  await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'release',
    generation: f.generation,
    epoch: taken.state.epoch,
  });
  f.execute.mockRejectedValueOnce(new Error('driver unavailable'));
  expect((await f.supervisor.execute(f.model('web_search'))).isError).toBe(true);
  expect((await f.controls.get(f.sessionId))?.needsObservation).toBe(true);
});
it('quarantines uncertain inputs and refuses replay, including after an explicit new takeover', async () => {
  const f = setup(),
    taken = await f.take(),
    input = f.input(taken);
  f.humanInput.mockRejectedValueOnce(new Error('lost response'));
  const failed = await f.supervisor.interact(input);
  expect(failed.error?.code).toBe('UNKNOWN_EFFECT');
  expect(failed.state.mode).toBe('quarantined');
  expect((await f.supervisor.interact(input)).error?.code).toBe('STALE_CONTROL');
  const again = await f.take();
  expect(
    (
      await f.supervisor.interact({
        ...input,
        epoch: again.state.epoch,
        frameId: again.frame!.frameId,
      })
    ).error?.code,
  ).toBe('INPUT_SEQUENCE');
  expect(f.humanInput).toHaveBeenCalledTimes(1);
});
it('rechecks ownership after capture before delivering private pixels', async () => {
  const f = setup();
  f.capture.mockImplementationOnce(async () => {
    f.revoke();
    return {
      preview: {
        state: 'frame',
        generation: f.generation,
        capturedAt: '2026-10-26T00:00:00Z',
        securityMode: 'trusted-managed',
        width: 100,
        height: 80,
        png: 'aW1hZ2U=',
      },
    };
  });
  const result = await f.take();
  expect(result.error?.code).toBe('NOT_AUTHORIZED');
  expect(result.frame).toBeUndefined();
});
it('resets only the owned browser and permits an explicit fresh allocation', async () => {
  const f = setup();
  await f.take();
  expect(
    (
      await f.supervisor.interact({
        sessionId: f.sessionId,
        viewId: randomUUID(),
        operation: 'reset',
      })
    ).error?.code,
  ).toBe('NOT_CONTROLLER');
  expect(
    (await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'reset' }))
      .state.available,
  ).toBe(false);
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect((await f.take()).state.mode).toBe('human');
  expect(f.create).toHaveBeenCalledTimes(2);
});

it.each(['take', 'frame', 'release'] as const)(
  'does not report an inactive browser when %s fails after taking control',
  async (operation) => {
    const f = setup();
    const taken = operation === 'take' ? undefined : await f.take();
    f.capture.mockRejectedValueOnce(new Error('private driver failure'));
    await expect(
      f.supervisor.interact({
        sessionId: f.sessionId,
        viewId: f.viewId,
        ...(operation === 'release'
          ? { operation, generation: f.generation, epoch: taken!.state.epoch }
          : { operation }),
      }),
    ).rejects.toMatchObject({
      code: 'DRIVER_FAILED',
      message: 'Managed browser interaction is unavailable.',
    });
    const recovered = await f.supervisor.interact({
      sessionId: f.sessionId,
      viewId: f.viewId,
      operation: 'state',
    });
    expect(recovered.state).toMatchObject({
      available: true,
      mode: 'human',
      generation: f.generation,
      controllerId: f.viewId,
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.dispose).not.toHaveBeenCalled();
    await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'reset' });
    expect((await f.take()).frame).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(2);
  },
);

it('does not invent an inactive browser when its durable state cannot be read', async () => {
  const f = setup();
  await f.take();
  vi.spyOn(f.controls, 'get').mockRejectedValueOnce(new Error('database unavailable'));
  await expect(
    f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'state' }),
  ).rejects.toMatchObject({ code: 'DRIVER_FAILED' });
  expect(
    (await f.supervisor.interact({ sessionId: f.sessionId, viewId: f.viewId, operation: 'state' }))
      .state.mode,
  ).toBe('human');
});

it('retains an applied input receipt when its subsequent picture fails', async () => {
  const f = setup();
  const input = f.input(await f.take());
  f.capture.mockRejectedValueOnce(new Error('capture failed after input'));
  await expect(f.supervisor.interact(input)).rejects.toMatchObject({ code: 'DRIVER_FAILED' });
  expect((await f.controls.input(f.sessionId, input.requestId))?.effect).toBe('applied');
  const recovered = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'state',
  });
  expect(recovered.state).toMatchObject({ available: true, mode: 'human', nextSequence: 2 });
  expect((await f.supervisor.interact(input)).input?.effect).toBe('applied');
  expect(f.humanInput).toHaveBeenCalledTimes(1);
});

it('journals explicit new-tab recovery without a frame and never repeats an uncertain effect', async () => {
  const f = setup();
  const taken = await f.take();
  const { frameId: _frameId, ...base } = f.input(taken);
  void _frameId;
  const request = { ...base, action: { type: 'new_tab' as const } };
  // Capture previously failed and no coordinate/keyboard authority remains.
  const record = f.controls.records.get(f.sessionId)!;
  record.frame = null;
  record.frames = [];
  f.humanInput.mockRejectedValueOnce(new Error('lost acknowledgement'));
  const result = await f.supervisor.interact(request);
  expect(result.error?.code).toBe('UNKNOWN_EFFECT');
  expect(f.humanInput).toHaveBeenCalledWith(
    request.action,
    { recovery: 'new_tab' },
    expect.any(AbortSignal),
  );
  await f.supervisor.interact(request);
  expect(f.humanInput).toHaveBeenCalledTimes(1);
  expect((await f.controls.input(f.sessionId, request.requestId))?.effect).toBe('unknown');
});

it('requires the current controller for frame-free recovery and delivers a fresh recovered frame', async () => {
  const f = setup();
  const taken = await f.take();
  const { frameId: _frameId, ...base } = f.input(taken);
  void _frameId;
  const request = { ...base, action: { type: 'new_tab' as const } };
  expect((await f.supervisor.interact({ ...request, viewId: randomUUID() })).error?.code).toBe(
    'NOT_CONTROLLER',
  );
  const result = await f.supervisor.interact(request);
  expect(result.input?.effect).toBe('applied');
  expect(result.frame).toBeDefined();
  expect(f.humanInput).toHaveBeenCalledTimes(1);
});

it('rejects frame-free page actions at the request boundary', async () => {
  const f = setup();
  const { frameId: _frameId, ...base } = f.input(await f.take());
  void _frameId;
  for (const action of [
    { type: 'navigate', url: 'https://example.com/' },
    { type: 'open_browser_page', page: 'account' },
    { type: 'reload' },
    { type: 'text', text: 'unsafe' },
    { type: 'click', point: { x: 1, y: 1 } },
  ]) {
    expect(browserInteractionRequestSchema.safeParse({ ...base, action }).success).toBe(false);
  }
  expect(
    browserInteractionRequestSchema.safeParse({ ...base, action: { type: 'new_tab' } }).success,
  ).toBe(true);
});

it('keeps capture-unavailable control leased for explicit recovery without retaining stale targets', async () => {
  const f = setup();
  await f.take();
  const before = f.controls.records.get(f.sessionId)!;
  const expires = before.expiresAt!;
  f.advance(4000);
  f.capture.mockResolvedValueOnce({
    preview: { state: 'unavailable' },
    unavailableReason: 'image_geometry',
  });
  const result = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'frame',
  });
  expect(result.error?.message).toContain('does not match the page viewport');
  expect(Date.parse(f.controls.records.get(f.sessionId)!.expiresAt!)).toBeGreaterThan(
    Date.parse(expires),
  );
  expect(f.controls.records.get(f.sessionId)).toMatchObject({
    frame: null,
    frames: [],
    keyboard: null,
  });
});

it('returns control from a verified native page with no model-visible pixels', async () => {
  const f = setup();
  const taken = await f.take();
  f.capture.mockResolvedValueOnce({
    preview: { state: 'unavailable' },
    handoff: 'navigation_only',
  });
  const result = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: f.viewId,
    operation: 'release',
    generation: f.generation,
    epoch: taken.state.epoch,
  });
  expect(result.error).toBeUndefined();
  expect(result.state.mode).toBe('agent');
  expect(result.frame).toBeUndefined();
  expect(f.controls.records.get(f.sessionId)?.needsObservation).toBe(true);
});

it('finishes an admitted frame read on view disconnect without killing Chrome and pauses its controller', async () => {
  const f = setup();
  await f.take();
  let entered!: () => void, finish!: () => void;
  const began = new Promise<void>((r) => {
      entered = r;
    }),
    block = new Promise<void>((r) => {
      finish = r;
    });
  const normal = f.capture.getMockImplementation()!;
  f.capture.mockImplementationOnce(async (privateView) => {
    entered();
    await block;
    return normal(privateView);
  });
  const controller = new AbortController();
  const pending = f.supervisor.interact(
    { sessionId: f.sessionId, viewId: f.viewId, operation: 'frame' },
    controller.signal,
  );
  await began;
  controller.abort();
  finish();
  const completed = await pending;
  expect(completed.frame).toBeUndefined();
  expect(completed.state.mode).toBe('paused');
  expect(f.dispose).not.toHaveBeenCalled();
  expect((await f.take()).state.mode).toBe('human');
  expect(f.create).toHaveBeenCalledTimes(1);
});

it('stops owned Chrome when a lease timer cannot read its durable control state', async () => {
  const lease = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) => (ms === 15_000 ? lease.signal : timeout(ms)));
  const f = setup();
  try {
    await f.take();
    vi.spyOn(f.controls, 'get').mockRejectedValue(new Error('database unavailable'));
    f.advance(15_001);
    await new Promise<void>((resolve) => {
      f.dispose.mockImplementationOnce(async () => {
        resolve();
        return undefined;
      });
      lease.abort();
    });
    expect(f.dispose).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

it('acknowledges inputs without capture and fences consecutive keyboard input independently of frames', async () => {
  const f = setup(),
    taken = await f.take();
  const keyboard = { tabId: 'tab', documentRevision: 'revision', focusRevision: 'focus:1' };
  f.humanInput.mockResolvedValue({ effect: 'applied', keyboard });
  const first = await f.supervisor.interact({ ...f.input(taken), capture: false });
  expect(first.input?.effect).toBe('applied');
  expect(first.frame).toBeUndefined();
  expect(first.keyboardId).toBeDefined();
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect((await f.controls.get(f.sessionId))?.frames).toEqual([]);
  f.advance(6000);
  const next = {
    ...f.input(taken),
    sequence: first.state.nextSequence,
    capture: false,
    keyboardId: first.keyboardId,
  };
  for (const patch of [
    { keyboardId: randomUUID() },
    {
      action: {
        type: 'click' as const,
        point: { x: 10, y: 10 },
        button: 'left' as const,
        count: 1,
        modifiers: [],
      },
    },
    { keyboardId: undefined },
  ])
    expect((await f.supervisor.interact({ ...next, ...patch })).error?.code).toBe('STALE_FRAME');
  expect(f.humanInput).toHaveBeenCalledTimes(1);
  const second = await f.supervisor.interact(next);
  expect(second.input?.effect).toBe('applied');
  expect(f.humanInput).toHaveBeenLastCalledWith(next.action, keyboard, expect.any(AbortSignal));
  expect(second.keyboardId).not.toBe(first.keyboardId);
  expect(f.capture).toHaveBeenCalledTimes(1);
  const replay = await f.supervisor.interact(next);
  expect(replay.input?.effect).toBe('applied');
  expect(f.humanInput).toHaveBeenCalledTimes(2);
  expect(
    (
      await f.supervisor.interact({
        ...next,
        requestId: randomUUID(),
        sequence: second.state.nextSequence,
      })
    ).error?.code,
  ).toBe('STALE_FRAME');
  const viewer = await f.supervisor.interact({
    sessionId: f.sessionId,
    viewId: randomUUID(),
    operation: 'frame',
  });
  expect(viewer.keyboardId).toBeUndefined();
});

it('journals a driver-rejected stale focus as no effect and never reexecutes that request', async () => {
  const f = setup(),
    taken = await f.take();
  f.humanInput.mockResolvedValue({ effect: 'none' });
  const request = { ...f.input(taken), capture: false };
  const result = await f.supervisor.interact(request);
  expect(result).toMatchObject({
    error: { code: 'STALE_FRAME' },
    input: { effect: 'none' },
    state: { mode: 'human' },
  });
  expect((await f.controls.get(f.sessionId))?.keyboard).toBeNull();
  expect((await f.controls.input(f.sessionId, request.requestId))?.effect).toBe('none');
  expect((await f.supervisor.interact(request)).input?.effect).toBe('none');
  expect(f.humanInput).toHaveBeenCalledTimes(1);
  expect(f.capture).toHaveBeenCalledTimes(1);
});
