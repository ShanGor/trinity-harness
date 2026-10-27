import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  ManagedBrowserSupervisor,
  ZendriverOperationGate,
  browserRuntimeFailure,
  type ZendriverMcpConnection,
} from '../packages/core/src/index.js';
import type {
  BrowserCommandRecord,
  BrowserControlRecord,
  BrowserInputRecord,
  BrowserInteractionStore,
  BrowserRuntimeRequest,
  BrowserRuntimeRecord,
  BrowserRuntimeStore,
  GuestRequestPort,
} from '../packages/contracts/src/index.js';

/** Disposable real-guest check; callers may supply isolated PostgreSQL stores. */
export async function checkGuestDesktopHandoff(
  connection: ZendriverMcpConnection,
  rpc: GuestRequestPort,
  sessionId: string,
  signal: AbortSignal,
  stores?: { journal: BrowserRuntimeStore; controls: BrowserInteractionStore },
): Promise<void> {
  const generation = randomUUID(),
    viewId = randomUUID();
  let binding: BrowserRuntimeRecord | null = null;
  const commands = new Map<string, BrowserCommandRecord>(),
    tails = new Map<string, Promise<void>>();
  const journal: BrowserRuntimeStore = {
    async run<T>(
      id: string,
      action: (signal: AbortSignal) => Promise<T>,
      active?: AbortSignal,
    ): Promise<T> {
      const previous = tails.get(id) ?? Promise.resolve();
      let done!: () => void;
      tails.set(
        id,
        new Promise<void>((resolve) => {
          done = resolve;
        }),
      );
      await previous;
      try {
        return await action(active ?? new AbortController().signal);
      } finally {
        done();
      }
    },
    binding: async () => binding,
    bind: async (record) => {
      binding = record;
    },
    command: async (_session, id) => commands.get(id) ?? null,
    begin: async (_session, id, hash) => {
      commands.set(id, { hash, result: null });
    },
    finish: async (_session, id, result) => {
      commands.get(id)!.result = result;
    },
  };
  let control: BrowserControlRecord | null = null;
  const inputs = new Map<string, BrowserInputRecord>();
  const controls: BrowserInteractionStore = {
    get: async () => (control ? structuredClone(control) : null),
    put: async (record) => {
      control = structuredClone(record);
    },
    input: async (_session, id) => inputs.get(id) ?? null,
    reserve: async (record, id, sourceSessionId) => {
      control = structuredClone(record);
      inputs.set(id, {
        sourceSessionId,
        generation: record.generation,
        epoch: record.epoch,
        sequence: record.sequence,
        viewId: record.controllerId!,
        effect: 'unknown',
      });
    },
    finish: async (_session, id, effect) => {
      inputs.get(id)!.effect = effect;
    },
  };
  let gate: ZendriverOperationGate | undefined;
  let dispatched!: () => void, settled!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const settledPromise = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const supervisor = new ManagedBrowserSupervisor({
    store: stores?.journal ?? journal,
    interactionStore: stores?.controls ?? controls,
    owner: randomUUID(),
    authorize: async () => true,
    authorizePreview: async () => true,
    maxSessions: 1,
    idleMs: 300_000,
    create: async () => ({
      generation,
      execute: async (request, active) => {
        gate = new ZendriverOperationGate(connection);
        try {
          const pending = gate.call(
            'browser_mouse',
            {
              action: 'click',
              x: 40,
              y: 40,
              button: 'left',
              click_count: 1,
              immediate: true,
              modifiers: [],
              return_snapshot: false,
            },
            active,
          );
          dispatched();
          await pending;
          await gate.call('browser_evaluate', { expression: 'true' }, active);
        } catch {
          return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
        } finally {
          gate = undefined;
          settled();
        }
        return browserRuntimeFailure(request, 'DRIVER_FAILED', 'unknown');
      },
      fenceAgent: () => {
        if (!gate) return false;
        gate.fence();
        return true;
      },
      humanFrame: async (privateView, active) => {
        if (!privateView) return { preview: { state: 'privacy_blocked' } };
        const capturedAt = new Date().toISOString();
        const picture = await rpc.call(sessionId, { kind: 'desktopFrame' }, active);
        if (picture.kind !== 'desktopFrame') throw new Error('Missing desktop frame');
        return {
          surface: 'desktop',
          preview: {
            state: 'frame',
            generation,
            capturedAt,
            securityMode: 'trusted-managed',
            width: picture.width,
            height: picture.height,
            png: picture.png,
          },
          target: {
            tabId: 'desktop',
            documentRevision: generation,
            fingerprint: 'a'.repeat(64),
            width: picture.width,
            height: picture.height,
            capturedAt,
            ...(picture.focusRevision ? { focusRevision: picture.focusRevision } : {}),
          },
        };
      },
      humanHandoff: async () => ({ preview: { state: 'unavailable' }, handoff: 'navigation_only' }),
      humanInput: async (action, target, active) => {
        if (!('frameId' in target) || action.type !== 'key') return { effect: 'none' };
        const result = await rpc.call(
          sessionId,
          {
            kind: 'desktopInput',
            action,
            target: {
              width: target.width,
              height: target.height,
              ...(target.focusRevision ? { focusRevision: target.focusRevision } : {}),
            },
          },
          active,
        );
        if (result.kind !== 'desktopInput') throw new Error('Unexpected desktop input response');
        return { effect: result.effect };
      },
      dispose: async () => {},
    }),
  });
  const command: BrowserRuntimeRequest = {
    sessionId,
    callId: randomUUID(),
    args: { operation: 'navigate', url: 'https://example.com/' },
    permissionGranted: false,
  };
  await connection.call(
    'browser_evaluate',
    {
      expression: `(()=>{const b=document.createElement('button');b.id='agent-handoff-fixture';b.textContent='Prompt';b.style='position:fixed;left:0;top:0;width:200px;height:100px;z-index:99999';b.onclick=()=>document.body.dataset.agentAnswer=prompt('Agent handoff','agent-default');document.body.appendChild(b);return true})()`,
    },
    signal,
  );
  const before = await rpc.call(sessionId, { kind: 'desktopFrame' }, signal);
  assert.equal(before.kind, 'desktopFrame');
  if (before.kind !== 'desktopFrame') throw new Error('Missing desktop frame');
  const png = createRequire(new URL('../packages/core/package.json', import.meta.url))('pngjs') as {
    PNG: { sync: { read: (bytes: Buffer) => { data: Buffer } } };
  };
  const beforePixels = png.PNG.sync.read(Buffer.from(before.png, 'base64'));
  const agent = supervisor.execute(command, signal);
  let complete = false;
  try {
    await started;
    let view = await supervisor.interact({ sessionId, viewId, operation: 'take' }, signal);
    assert.equal(view.frame?.surface, 'desktop');
    let visible = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      view = await supervisor.interact({ sessionId, viewId, operation: 'frame' }, signal);
      if (!view.frame) continue;
      const after = png.PNG.sync.read(Buffer.from(view.frame.png, 'base64'));
      let changed = 0;
      for (let i = 0; i < after.data.length; i += 4)
        if (Math.abs(after.data[i]! - beforePixels.data[i]!) > 40) changed++;
      if (changed > 10_000) {
        visible = true;
        break;
      }
    }
    assert(visible && view.frame, 'The desktop did not show the blocked agent dialog');
    const input = await supervisor.interact(
      {
        sessionId,
        viewId,
        operation: 'input',
        generation,
        epoch: view.state.epoch,
        sequence: view.state.nextSequence,
        requestId: randomUUID(),
        frameId: view.frame.frameId,
        action: { type: 'key', key: 'Enter', modifiers: [] },
      },
      signal,
    );
    assert.equal(input.input?.effect, 'applied');
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(new Error('Guest handoff did not settle'));
      signal.addEventListener('abort', abort, { once: true });
      void settledPromise.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
      if (signal.aborted) abort();
    });
    const release = await supervisor.interact(
      { sessionId, viewId, operation: 'release', generation, epoch: input.state.epoch },
      signal,
    );
    assert.equal(release.state.mode, 'agent');
    const outcome = await agent;
    assert(outcome.isError && outcome.value.kind === 'browser-error-v1');
    assert.equal(outcome.value.effect, 'unknown');
    assert.deepEqual(
      (
        await connection.call(
          'browser_evaluate',
          { expression: 'document.body.dataset.agentAnswer' },
          signal,
        )
      ).structuredContent,
      { value: 'agent-default' },
    );
    await connection.call(
      'browser_evaluate',
      { expression: "document.getElementById('agent-handoff-fixture').remove()" },
      signal,
    );
    complete = true;
  } finally {
    if (!complete) await connection.dispose();
    await supervisor.dispose();
  }
}
