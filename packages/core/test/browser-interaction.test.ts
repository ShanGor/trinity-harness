import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  browserControlRecordSchema,
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
} from '@trinity-harness/contracts';
import { ManagedBrowserSupervisor, MemorySessionStore } from '../src/index.js';

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
  async reserve(record: BrowserControlRecord, key: string): Promise<void> {
    if (this.inputs.has(`${record.sessionId}/${key}`)) throw Error('duplicate');
    await this.put(record);
    this.inputs.set(`${record.sessionId}/${key}`, {
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
function setup() {
  const sessionId = randomUUID(),
    viewId = randomUUID(),
    generation = randomUUID();
  const controls = new Controls(),
    journal = new Journal(),
    events = new MemorySessionStore();
  let time = Date.parse('2026-10-26T00:00:00Z');
  let owner = true;
  let privatePage = false;
  const humanInput = vi.fn(async (): Promise<BrowserHumanInputResult | void> => undefined),
    execute = vi.fn(async (request: BrowserRuntimeRequest) => result(request)),
    dispose = vi.fn(async () => undefined);
  const capture = vi.fn(async (privateView: boolean): Promise<BrowserHumanCapture> =>
    privatePage && !privateView
      ? { preview: { state: 'privacy_blocked' } }
      : {
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
        },
  );
  const create = vi.fn(async () => ({
    generation,
    execute,
    dispose,
    humanFrame: capture,
    humanInput,
  }));
  const supervisor = new ManagedBrowserSupervisor({
    store: journal,
    interactionStore: controls,
    events,
    owner: randomUUID(),
    authorize: async () => owner,
    authorizePreview: async () => owner,
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
    viewId,
    generation,
    controls,
    journal,
    events,
    humanInput,
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
  };
}
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
