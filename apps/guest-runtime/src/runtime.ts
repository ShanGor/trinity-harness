import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  GuestEnvelope,
  GuestValue,
  LongRunningProcess,
  SandboxPort,
  SkillCatalogPort,
  GuestOperationFailure,
} from '@trinity-harness/contracts';

interface ProcessRecord {
  sessionId: string;
  workspace: string;
  child: LongRunningProcess;
  buffer: Buffer;
  floor: number;
  sent: number;
  seq: number;
  hash: string;
  ended: boolean;
  exitCode: number | null;
  changed: EventEmitter;
  idle: AbortController;
}
/** Per-VM stateful execution infrastructure; no control-plane credentials. */
export class GuestRuntime {
  private readonly processes = new Map<string, ProcessRecord>();
  private readonly shutdown = new AbortController();
  constructor(
    private readonly environmentId: string,
    private readonly generation: string,
    private readonly sandboxFor: (workspace: string) => Promise<SandboxPort>,
    private readonly skills: SkillCatalogPort,
    private readonly rootFor: (workspace: string) => string,
    private readonly idleMs = 120_000,
    private readonly openBrowser?: (
      sessionId: string,
      signal: AbortSignal,
    ) => Promise<LongRunningProcess>,
  ) {}
  private arm(record: ProcessRecord): void {
    record.idle.abort();
    record.idle = new AbortController();
    AbortSignal.any([record.idle.signal, AbortSignal.timeout(this.idleMs)]).addEventListener(
      'abort',
      () => {
        if (!record.idle.signal.aborted) {
          record.child.kill();
          record.ended = true;
          record.changed.emit('change');
          for (const [id, candidate] of this.processes)
            if (candidate === record) this.processes.delete(id);
        }
      },
      { once: true },
    );
  }
  private process(request: GuestEnvelope, id: string): ProcessRecord {
    const record = this.processes.get(id);
    if (!record || record.sessionId !== request.sessionId || record.workspace !== request.workspace)
      throw new Error('Guest process ownership mismatch');
    this.arm(record);
    return record;
  }
  private async read(
    operation: GuestOperationFailure['operation'],
    run: () => Promise<GuestValue>,
  ): Promise<GuestValue> {
    try {
      return await run();
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const failure = {
        ENOENT: 'FILE_NOT_FOUND',
        EACCES: 'ACCESS_DENIED',
        EPERM: 'ACCESS_DENIED',
        ENOTDIR: 'NOT_A_DIRECTORY',
        EISDIR: 'IS_A_DIRECTORY',
      } as const;
      if (typeof code !== 'string' || !Object.hasOwn(failure, code)) throw error;
      return {
        kind: 'operationError',
        operation,
        code: failure[code as keyof typeof failure],
        effect: 'none',
      };
    }
  }
  async execute(request: GuestEnvelope, signal?: AbortSignal): Promise<GuestValue> {
    if (request.environmentId !== this.environmentId || request.generation !== this.generation)
      throw new Error('Stale guest generation');
    const active = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    active.throwIfAborted();
    const op = request.operation;
    if (op.kind === 'desktopFrame' || op.kind === 'desktopInput')
      throw new Error('Desktop operations are unavailable on the workspace endpoint');
    if (op.kind === 'processRead' || op.kind === 'processWrite' || op.kind === 'processKill') {
      const record = this.process(request, op.processId);
      if (op.kind === 'processKill') {
        record.child.kill();
        record.idle.abort();
        await record.child.exited;
        record.ended = true;
        record.changed.emit('change');
        this.processes.delete(op.processId);
        return { kind: 'ok' };
      }
      if (op.kind === 'processWrite') {
        const hash = createHash('sha256').update(op.data).digest('hex');
        if (op.seq === record.seq && record.hash === hash) return { kind: 'ok' };
        if (op.seq !== record.seq + 1 || record.ended)
          throw new Error('Guest process input sequence mismatch');
        const data = Buffer.from(op.data, 'base64');
        if (data.length > 1024 * 1024) throw new Error('Guest process input overflow');
        record.child.write(data);
        record.seq = op.seq;
        record.hash = hash;
        return { kind: 'ok' };
      }
      if (op.cursor < record.floor || op.cursor > record.sent)
        throw new Error('Guest process output cursor mismatch');
      record.buffer = record.buffer.subarray(op.cursor - record.floor);
      record.floor = op.cursor;
      if (!record.buffer.length && !record.ended) {
        const wait = AbortSignal.any([active, AbortSignal.timeout(25_000)]);
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            record.changed.removeListener('change', finish);
            wait.removeEventListener('abort', finish);
            resolve();
          };
          record.changed.once('change', finish);
          wait.addEventListener('abort', finish, { once: true });
          if (wait.aborted || record.buffer.length || record.ended) finish();
        });
      }
      active.throwIfAborted();
      const data = record.buffer.subarray(0, 128 * 1024);
      const cursor = record.floor + data.length;
      record.sent = Math.max(record.sent, cursor);
      return {
        kind: 'processOutput',
        data: data.toString('base64'),
        cursor,
        exited: record.ended && data.length === record.buffer.length,
        exitCode: record.exitCode,
      };
    }
    const sandbox = await this.sandboxFor(request.workspace);
    const root = this.rootFor(request.workspace);
    switch (op.kind) {
      case 'exec': {
        if (!sandbox.execArgv) throw new Error('Bounded execution unavailable');
        const result = await sandbox.execArgv(
          op.args ? op.command : 'bash',
          op.args ?? ['-c', op.command],
          { ...op.options, signal: active, maxOutputBytes: op.maxOutputBytes },
        );
        return { kind: 'exec', ...result };
      }
      case 'read':
        return this.read('read', async () => ({
          kind: 'read',
          ...(await sandbox.readFile(op.path, { maxBytes: op.maxBytes })),
        }));
      case 'readBytes': {
        if (!sandbox.readBytes) throw new Error('Binary reading unavailable');
        const readBytes = sandbox.readBytes.bind(sandbox);
        return this.read('readBytes', async () => ({
          kind: 'bytes',
          data: Buffer.from(await readBytes(op.path, op.maxBytes)).toString('base64'),
        }));
      }
      case 'write':
        await sandbox.writeFile(op.path, op.content);
        return { kind: 'ok' };
      case 'writeBytes': {
        if (!sandbox.writeBytes) throw new Error('Binary writing unavailable');
        await sandbox.writeBytes(op.path, Buffer.from(op.data, 'base64'));
        return { kind: 'ok' };
      }
      case 'remove':
        if (!sandbox.removeFile) throw new Error('Removal unavailable');
        await sandbox.removeFile(op.path);
        return { kind: 'ok' };
      case 'edit':
        return { kind: 'edit', ...(await sandbox.editFile(op.path, op.oldText, op.newText)) };
      case 'glob':
        return { kind: 'glob', paths: await sandbox.glob(op.pattern) };
      case 'skillsList':
        return { kind: 'skills', catalog: await this.skills.list(root, active) };
      case 'skillLoad':
        return { kind: 'skill', definition: await this.skills.load(root, op.name, active) };
      case 'skillResource': {
        const skill = await this.skills.load(root, op.name, active);
        if (skill.version !== op.version) throw new Error('Guest skill changed');
        return {
          kind: 'resource',
          content: await this.skills.readResource(skill, op.resource, active),
        };
      }
      case 'browserOpen':
      case 'processOpen': {
        if (this.processes.size >= 16) throw new Error('Guest process capacity exhausted');
        const child =
          op.kind === 'browserOpen'
            ? await this.openBrowser?.(request.sessionId, active)
            : sandbox.openProcess(op.command, op.args, {
                ...op.options,
                processGroup: true,
                signal: this.shutdown.signal,
              });
        if (!child) throw new Error('Guest Zendriver is unavailable');
        if (this.processes.size >= 16) {
          child.kill();
          await child.exited;
          throw new Error('Guest process capacity exhausted');
        }
        const id = randomUUID();
        const record: ProcessRecord = {
          sessionId: request.sessionId,
          workspace: request.workspace,
          child,
          buffer: Buffer.alloc(0),
          floor: 0,
          sent: 0,
          seq: 0,
          hash: '',
          ended: false,
          exitCode: null,
          changed: new EventEmitter(),
          idle: new AbortController(),
        };
        this.processes.set(id, record);
        this.arm(record);
        void (async () => {
          try {
            for await (const data of child.chunks()) {
              if (record.buffer.length + data.byteLength > 4 * 1024 * 1024) {
                child.kill();
                break;
              }
              record.buffer = Buffer.concat([record.buffer, data]);
              record.changed.emit('change');
            }
            record.exitCode = await child.exited;
          } catch {
            child.kill();
          } finally {
            record.ended = true;
            record.changed.emit('change');
          }
        })();
        return { kind: 'process', processId: id };
      }
    }
  }
  async dispose(): Promise<void> {
    this.shutdown.abort();
    const records = [...this.processes.values()];
    for (const record of records) {
      record.idle.abort();
      record.child.kill();
      record.changed.emit('change');
    }
    await Promise.all(records.map((record) => record.child.exited));
    this.processes.clear();
  }
}
