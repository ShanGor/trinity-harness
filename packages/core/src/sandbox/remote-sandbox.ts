import type {
  GuestRequestPort,
  GuestOperation,
  GuestValue,
  SandboxPort,
  ExecOptions,
  ArgvExecOptions,
  ExecResult,
  BoundedExecResult,
  ReadFileResult,
  EditFileResult,
  LongRunningProcess,
  OpenProcessOptions,
  SkillCatalogPort,
  SkillCatalogResult,
  SkillDefinition,
} from '@trinity-harness/contracts';

function result<K extends GuestValue['kind']>(
  value: GuestValue,
  kind: K,
): Extract<GuestValue, { kind: K }> {
  if (value.kind !== kind) throw new Error('Guest result kind mismatch');
  return value as Extract<GuestValue, { kind: K }>;
}
function options(opts?: ExecOptions): {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
} {
  return {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
}
export class RemoteSandbox implements SandboxPort {
  constructor(
    private readonly rpc: GuestRequestPort,
    private readonly sessionId: string,
    private readonly signal?: AbortSignal,
  ) {}
  withSignal(signal?: AbortSignal): SandboxPort {
    return new RemoteSandbox(
      this.rpc,
      this.sessionId,
      this.signal && signal ? AbortSignal.any([this.signal, signal]) : (this.signal ?? signal),
    );
  }
  private call(op: GuestOperation, signal?: AbortSignal): Promise<GuestValue> {
    return this.rpc.call(
      this.sessionId,
      op,
      this.signal && signal ? AbortSignal.any([this.signal, signal]) : (this.signal ?? signal),
    );
  }
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const response = result(
      await this.call(
        { kind: 'exec', command, options: options(opts), maxOutputBytes: 10 * 1024 * 1024 },
        opts?.signal,
      ),
      'exec',
    );
    return { stdout: response.stdout, stderr: response.stderr, exitCode: response.exitCode };
  }
  async execArgv(
    command: string,
    args: string[],
    opts: ArgvExecOptions,
  ): Promise<BoundedExecResult> {
    const response = result(
      await this.call(
        {
          kind: 'exec',
          command,
          args,
          options: options(opts),
          maxOutputBytes: opts.maxOutputBytes,
        },
        opts.signal,
      ),
      'exec',
    );
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
      outputOverflow: response.outputOverflow,
    };
  }
  async readFile(path: string, opts?: { maxBytes?: number }): Promise<ReadFileResult> {
    const response = result(
      await this.call({ kind: 'read', path, maxBytes: opts?.maxBytes ?? 100000 }),
      'read',
    );
    return { content: response.content, truncated: response.truncated };
  }
  async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    return Buffer.from(
      result(await this.call({ kind: 'readBytes', path, maxBytes }), 'bytes').data,
      'base64',
    );
  }
  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    result(
      await this.call({ kind: 'writeBytes', path, data: Buffer.from(content).toString('base64') }),
      'ok',
    );
  }
  async writeFile(path: string, content: string): Promise<void> {
    result(await this.call({ kind: 'write', path, content }), 'ok');
  }
  async removeFile(path: string): Promise<void> {
    result(await this.call({ kind: 'remove', path }), 'ok');
  }
  async editFile(path: string, oldText: string, newText: string): Promise<EditFileResult> {
    const response = result(await this.call({ kind: 'edit', path, oldText, newText }), 'edit');
    return { content: response.content, replacements: response.replacements };
  }
  async glob(pattern: string): Promise<string[]> {
    return result(await this.call({ kind: 'glob', pattern }), 'glob').paths;
  }
  openProcess(command: string, args: string[], opts?: OpenProcessOptions): LongRunningProcess {
    return this.open({ kind: 'processOpen', command, args, options: options(opts) }, opts?.signal);
  }
  openBrowser(signal?: AbortSignal): LongRunningProcess {
    return this.open({ kind: 'browserOpen' }, undefined, signal);
  }
  private open(
    operation: GuestOperation,
    parentSignal?: AbortSignal,
    allocationSignal?: AbortSignal,
  ): LongRunningProcess {
    const controller = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal;
    let seq = 0;
    let pendingInputBytes = 0;
    let exitedReject!: (error: Error) => void;
    let exitedResolve!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve, reject) => {
      exitedResolve = resolve;
      exitedReject = reject;
    });
    void exited.catch(() => controller.abort());
    const opened = this.call(
      operation,
      allocationSignal ? AbortSignal.any([signal, allocationSignal]) : signal,
    ).then((value) => result(value, 'process').processId);
    let writes = Promise.resolve();
    let stopping: Promise<void> | undefined;
    const kill = (): void => {
      stopping ??= (async () => {
        // Let an in-flight allocation acknowledge before requesting teardown.
        try {
          const processId = await opened;
          await this.rpc.call(
            this.sessionId,
            { kind: 'processKill', processId },
            AbortSignal.timeout(5000),
          );
        } catch {
          const error = new Error('Guest process termination could not be confirmed');
          exitedReject(error);
          controller.abort(error);
        } finally {
          controller.abort();
          exitedResolve(null);
        }
      })();
    };
    // Allocation failure must never become an unhandled promise rejection.
    void opened.catch(() => {
      controller.abort();
      exitedReject(new Error('Guest process allocation outcome is unknown'));
    });
    signal.addEventListener('abort', kill, { once: true });
    const call = (operation: GuestOperation): Promise<GuestValue> => this.call(operation, signal);
    return {
      exited,
      kill,
      write(data) {
        if (signal.aborted) throw new Error('Guest process stopped');
        pendingInputBytes += data.byteLength;
        if (pendingInputBytes > 1024 * 1024) {
          kill();
          throw new Error('Guest process input queue overflow');
        }
        const frame = Buffer.from(data).toString('base64');
        const current = ++seq;
        writes = writes.then(async () => {
          const processId = await opened;
          try {
            result(
              await call({ kind: 'processWrite', processId, seq: current, data: frame }),
              'ok',
            );
          } finally {
            pendingInputBytes -= data.byteLength;
          }
        });
        void writes.catch(kill);
      },
      async *chunks() {
        let cursor = 0;
        try {
          const processId = await opened;
          while (!signal.aborted) {
            const output = result(
              await call({ kind: 'processRead', processId, cursor }),
              'processOutput',
            );
            if (output.cursor !== cursor + Buffer.from(output.data, 'base64').length)
              throw new Error('Guest process cursor mismatch');
            cursor = output.cursor;
            if (output.data) yield Buffer.from(output.data, 'base64');
            if (output.exited) {
              exitedResolve(output.exitCode);
              break;
            }
          }
        } finally {
          kill();
        }
      },
    };
  }
}

export class RemoteSkillCatalog implements SkillCatalogPort {
  constructor(
    private readonly rpc: GuestRequestPort,
    private readonly sessionId: string,
  ) {}
  async list(_root: string, signal?: AbortSignal): Promise<SkillCatalogResult> {
    return result(await this.rpc.call(this.sessionId, { kind: 'skillsList' }, signal), 'skills')
      .catalog;
  }
  async load(_root: string, name: string, signal?: AbortSignal): Promise<SkillDefinition> {
    return result(await this.rpc.call(this.sessionId, { kind: 'skillLoad', name }, signal), 'skill')
      .definition;
  }
  async readResource(
    skill: SkillDefinition,
    resource: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return result(
      await this.rpc.call(
        this.sessionId,
        { kind: 'skillResource', name: skill.name, version: skill.version, resource },
        signal,
      ),
      'resource',
    ).content;
  }
}
