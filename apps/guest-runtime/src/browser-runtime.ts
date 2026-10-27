import {
  guestEnvelopeSchema,
  type BrowserHumanAction,
  type GuestEnvelope,
  type GuestValue,
  type LongRunningProcess,
} from '@trinity-harness/contracts';
import type { GuestRuntime } from './runtime.js';
import type { GuestDesktop } from './desktop.js';

type ProcessRuntime = Pick<GuestRuntime, 'execute' | 'dispose'>;
type DesktopPort = Pick<GuestDesktop, 'capture' | 'input' | 'environment' | 'signal' | 'dispose'>;
interface Owner {
  sessionId: string;
  workspace: string;
  desktop?: DesktopPort;
  child?: LongRunningProcess;
  allocating?: Promise<LongRunningProcess>;
  cleanup?: Promise<void>;
}

/** Private browser-UID guest service. Authorization remains with the host supervisor. */
export class BrowserGuestRuntime {
  private readonly shutdown = new AbortController();
  private owner: Owner | undefined;
  constructor(
    private readonly environmentId: string,
    private readonly generation: string,
    private readonly runtime: ProcessRuntime,
    private readonly launchDesktop: (signal: AbortSignal) => Promise<DesktopPort>,
    private readonly launchBrowser: (
      sessionId: string,
      env: Record<string, string>,
      signal: AbortSignal,
    ) => Promise<LongRunningProcess>,
  ) {}
  private cleanup(owner: Owner): Promise<void> {
    owner.cleanup ??= (async () => {
      await owner.allocating?.catch(() => undefined);
      owner.child?.kill();
      await owner.child?.exited;
      await owner.desktop?.dispose();
      if (this.owner === owner) this.owner = undefined;
    })();
    return owner.cleanup;
  }
  /** Called only by the injected process runtime during browserOpen. */
  async openProcess(sessionId: string, signal: AbortSignal): Promise<LongRunningProcess> {
    const owner = this.owner;
    if (!owner || owner.sessionId !== sessionId || owner.desktop || owner.cleanup)
      throw new Error('Browser desktop ownership mismatch');
    const allocating = this.allocate(owner, sessionId, signal);
    owner.allocating = allocating;
    try {
      return await allocating;
    } finally {
      if (owner.allocating === allocating) owner.allocating = undefined;
    }
  }
  private async allocate(
    owner: Owner,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<LongRunningProcess> {
    const desktop = await this.launchDesktop(signal);
    if (owner.cleanup || this.owner !== owner || signal.aborted) {
      await desktop.dispose();
      throw new Error('Browser desktop allocation cancelled');
    }
    owner.desktop = desktop;
    signal.throwIfAborted();
    const child = await this.launchBrowser(sessionId, desktop.environment(), signal);
    if (owner.cleanup || this.owner !== owner || signal.aborted) {
      child.kill();
      await child.exited;
      throw new Error('Browser process allocation cancelled');
    }
    owner.child = child;
    const stop = (): void => child.kill();
    desktop.signal.addEventListener('abort', stop, { once: true });
    if (desktop.signal.aborted) stop();
    void child.exited.then(
      () => {
        desktop.signal.removeEventListener('abort', stop);
        void this.cleanup(owner).catch(() => this.shutdown.abort());
      },
      () => {
        desktop.signal.removeEventListener('abort', stop);
        void this.cleanup(owner).catch(() => this.shutdown.abort());
      },
    );
    return child;
  }
  async execute(input: GuestEnvelope, signal?: AbortSignal): Promise<GuestValue> {
    const request = guestEnvelopeSchema.parse(input);
    if (request.environmentId !== this.environmentId || request.generation !== this.generation)
      throw new Error('Stale guest generation');
    const active = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    active.throwIfAborted();
    const kind = request.operation.kind;
    if (
      ![
        'browserOpen',
        'processRead',
        'processWrite',
        'processKill',
        'desktopFrame',
        'desktopInput',
      ].includes(kind)
    )
      throw new Error('Operation unavailable on browser endpoint');
    if (kind === 'browserOpen') {
      if (this.owner) throw new Error('Guest browser is already allocated');
      const owner: Owner = { sessionId: request.sessionId, workspace: request.workspace };
      this.owner = owner;
      try {
        const result = await this.runtime.execute(request, active);
        active.throwIfAborted();
        return result;
      } catch (error) {
        await this.cleanup(owner);
        throw error;
      }
    }
    const owner = this.owner;
    if (
      !owner ||
      owner.cleanup ||
      owner.sessionId !== request.sessionId ||
      owner.workspace !== request.workspace
    )
      throw new Error('Browser desktop ownership mismatch');
    if (request.operation.kind === 'desktopFrame') {
      if (!owner.desktop || !owner.child) throw new Error('Browser desktop unavailable');
      return owner.desktop.capture(active);
    }
    if (request.operation.kind === 'desktopInput') {
      if (!owner.desktop || !owner.child) throw new Error('Browser desktop unavailable');
      const action: BrowserHumanAction = request.operation.action;
      switch (action.type) {
        case 'click':
        case 'drag':
        case 'scroll':
        case 'key':
        case 'text':
          return {
            kind: 'desktopInput',
            effect: await owner.desktop.input(action, request.operation.target, active),
          };
        default:
          throw new Error('Unsupported desktop input');
      }
    }
    const result = await this.runtime.execute(request, active);
    if (kind === 'processKill') await this.cleanup(owner);
    return result;
  }
  async dispose(): Promise<void> {
    this.shutdown.abort();
    await this.runtime.dispose();
    if (this.owner) await this.cleanup(this.owner);
  }
}
