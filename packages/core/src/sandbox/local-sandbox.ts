import { spawn } from 'node:child_process';
import { glob as fsGlob } from 'node:fs/promises';
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import type {
  ArgvExecOptions,
  BoundedExecResult,
  EditFileResult,
  ExecOptions,
  ExecResult,
  LongRunningProcess,
  OpenProcessOptions,
  ReadFileResult,
  SandboxPort,
} from '@trinity-harness/contracts';

const DEFAULT_MAX_BYTES = 100_000;
/** Hard ceiling so a huge file cannot exhaust memory before truncation. */
const STAT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * M5 hardening (docs/design.md §12.3): `minimal` (DEFAULT) scrubs the env of
 * every spawned shell/process so server-side secrets (model API keys,
 * TOKEN_SECRET, DATABASE_URL, …) can never leak into tool-executed children
 * (AGENTS.md §5). `inherit` is the legacy full-passthrough mode for local
 * convenience only — never used in composed deployments.
 */
export type SandboxEnvMode = 'minimal' | 'inherit';

export interface LocalSandboxOptions {
  envMode?: SandboxEnvMode | undefined;
}

/**
 * Local development sandbox (docs/design.md §12.3, M1): filesystem rooted at
 * the workspace directory, commands via `bash -c`. This class is the ONLY
 * place in the repo allowed to spawn processes or touch the FS outside tests.
 */
export class LocalSandbox implements SandboxPort {
  private readonly envMode: SandboxEnvMode;

  constructor(
    private readonly workspaceRoot: string,
    opts?: LocalSandboxOptions,
  ) {
    this.envMode = opts?.envMode ?? 'minimal';
  }

  /**
   * The environment handed to spawned children. `minimal` keeps only
   * operational variables (PATH so bash/python/node resolve, HOME/LANG/TZ/
   * TMPDIR for language servers); everything else — in particular all
   * secrets — stays server-side.
   */
  private childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    if (this.envMode === 'inherit') {
      return { ...process.env, ...extra };
    }
    const minimal: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'TZ',
      'TMPDIR',
      'USER',
      'SHELL',
      'XDG_RUNTIME_DIR',
    ]) {
      const value = process.env[key];
      if (value !== undefined) minimal[key] = value;
    }
    minimal['TRINITY_WORKSPACE'] = this.workspaceRoot;
    return { ...minimal, ...extra };
  }

  /** Resolves a workspace-relative path and refuses escapes. */
  resolve(relativePath: string): string {
    const abs = path.resolve(this.workspaceRoot, relativePath);
    if (abs !== this.workspaceRoot && !abs.startsWith(this.workspaceRoot + path.sep)) {
      throw new Error(`path escapes workspace: ${relativePath}`);
    }
    return abs;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const { stdout, stderr, exitCode } = await this.runProcess(
      'bash',
      ['-c', command],
      opts,
      MAX_BUFFER,
    );
    return { stdout, stderr, exitCode };
  }

  async execArgv(
    command: string,
    args: string[],
    opts: ArgvExecOptions,
  ): Promise<BoundedExecResult> {
    if (
      !Number.isSafeInteger(opts.maxOutputBytes) ||
      opts.maxOutputBytes < 1 ||
      opts.maxOutputBytes > MAX_BUFFER
    )
      throw new Error('invalid process output limit');
    const result = await this.runProcess(command, args, opts, opts.maxOutputBytes);
    const truncate = (value: string, bytes: number): string => {
      const points = Array.from(value);
      let low = 0,
        high = points.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(points.slice(0, mid).join('')) <= bytes) low = mid;
        else high = mid - 1;
      }
      return points.slice(0, low).join('');
    };
    const stdout = truncate(result.stdout, opts.maxOutputBytes);
    const stderr = truncate(result.stderr, opts.maxOutputBytes - Buffer.byteLength(stdout));
    return { ...result, stdout, stderr };
  }

  private async runProcess(
    command: string,
    args: string[],
    opts: ExecOptions | undefined,
    maxBytes: number,
  ): Promise<BoundedExecResult> {
    const cwd = opts?.cwd ? this.resolve(opts.cwd) : this.workspaceRoot;
    const signals = [
      AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
      ...(opts?.signal ? [opts.signal] : []),
    ];
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    return new Promise<BoundedExecResult>((resolvePromise) => {
      const child = spawn(command, args, {
        cwd,
        env: this.childEnv(opts?.env),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let outputOverflow = false;
      let failure: string | undefined;
      let settled = false;
      let escalation: AbortSignal | undefined;
      const kill = (kind: NodeJS.Signals): void => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill(kind);
          else process.kill(-child.pid, kind);
        } catch (err) {
          // ESRCH means the command group has already exited.
          if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) {
            console.error('[LocalSandbox] command group cancellation failed', err);
          }
        }
      };
      const forceKill = (): void => kill('SIGKILL');
      const onAbort = (): void => {
        kill('SIGTERM');
        escalation = AbortSignal.timeout(1000);
        escalation.addEventListener('abort', forceKill, { once: true });
      };
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        escalation?.removeEventListener('abort', forceKill);
        resolvePromise({
          outputOverflow,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr:
            Buffer.concat(stderr).toString('utf8') ||
            failure ||
            (signal.aborted ? 'command cancelled or timed out' : ''),
          exitCode: signal.aborted ? 124 : failure ? 1 : (code ?? 1),
        });
      };
      const capture = (target: Buffer[], chunk: Buffer): void => {
        const remaining = Math.max(maxBytes - bytes, 0);
        target.push(chunk.subarray(0, remaining));
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          outputOverflow = true;
          failure = 'command output exceeded the buffer limit';
          kill('SIGKILL');
        }
      };
      child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
      child.once('error', (err) => {
        failure = err.message;
        finish(1);
      });
      child.once('close', (code) => finish(code));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async readFile(relativePath: string, opts?: { maxBytes?: number }): Promise<ReadFileResult> {
    const abs = this.resolve(relativePath);
    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    const buf = await readFile(abs);
    if (buf.byteLength > STAT_MAX_BYTES) {
      throw new Error(`file too large to read (${buf.byteLength} bytes): ${relativePath}`);
    }
    const slice = buf.subarray(0, maxBytes);
    return {
      content: slice.toString('utf8'),
      truncated: buf.byteLength > maxBytes,
    };
  }

  async readBytes(relativePath: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STAT_MAX_BYTES)
      throw new Error('invalid binary file limit');
    const file = await open(this.resolve(relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('binary file exceeds limit');
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > maxBytes) throw new Error('binary file exceeds limit');
      return bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  async removeFile(relativePath: string): Promise<void> {
    try {
      await unlink(this.resolve(relativePath));
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const abs = this.resolve(relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  async editFile(relativePath: string, oldText: string, newText: string): Promise<EditFileResult> {
    const { content } = await this.readFile(relativePath, { maxBytes: STAT_MAX_BYTES });
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`edit_file: old_text not found in ${relativePath}`);
    }
    if (occurrences > 1) {
      throw new Error(
        `edit_file: old_text matches ${occurrences} locations in ${relativePath}; it must match exactly one`,
      );
    }
    const updated = content.replace(oldText, newText);
    await this.writeFile(relativePath, updated);
    return { content: updated, replacements: 1 };
  }

  async glob(pattern: string): Promise<string[]> {
    // node:fs glob yields an async iterator of workspace-relative paths.
    const matches: string[] = [];
    for await (const match of fsGlob(pattern, { cwd: this.workspaceRoot })) {
      matches.push(match);
    }
    return matches;
  }

  /**
   * Long-running stdio process (M4 LSP, docs/design.md §9). stderr is drained
   * to the void (language servers are chatty); the caller consumes stdout as
   * raw byte chunks and does its own framing (LSP Content-Length headers).
   */
  openProcess(command: string, args: string[], opts?: OpenProcessOptions): LongRunningProcess {
    if (opts?.processGroup && process.platform === 'win32')
      throw new Error('Browser process groups require POSIX');
    const cwd = opts?.cwd ? this.resolve(opts.cwd) : this.workspaceRoot;
    const child = spawn(command, args, {
      cwd,
      env: this.childEnv(opts?.env),
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: opts?.processGroup === true,
    });
    let exitResolve!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exitResolve = resolve;
    });
    child.once('exit', (code) => exitResolve(code));
    child.once('error', () => exitResolve(null));
    // Graceful termination first: SIGTERM lets Chrome (and language servers)
    // clean up their own state — Chrome removes its Singleton* profile locks
    // on a graceful exit — while the bounded SIGKILL escalation guarantees a
    // hung child cannot outlive disposal. kill() is idempotent so an abort
    // signal and an explicit dispose cannot double-terminate the group.
    let terminated = false;
    let escalation: AbortSignal | undefined;
    const kill = (): void => {
      if (terminated) return;
      terminated = true;
      const signal = (kind: NodeJS.Signals): void => {
        try {
          if (opts?.processGroup && child.pid) process.kill(-child.pid, kind);
          else child.kill(kind);
        } catch (err) {
          if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) throw err;
        }
      };
      signal('SIGTERM');
      if (opts?.processGroup) {
        escalation = AbortSignal.timeout(2000);
        escalation.addEventListener('abort', () => signal('SIGKILL'), { once: true });
      }
    };
    child.once('exit', () => {
      terminated = true;
    });
    opts?.signal?.addEventListener('abort', kill, { once: true });
    child.once('close', () => opts?.signal?.removeEventListener('abort', kill));
    if (opts?.signal?.aborted) kill();
    const stdout = child.stdout;
    return {
      write: (data) => {
        if (!child.killed && child.stdin.writable) {
          child.stdin.write(data);
        }
      },
      chunks: (): AsyncIterable<Uint8Array> =>
        (async function* (): AsyncIterable<Uint8Array> {
          for await (const chunk of stdout) {
            yield chunk as Uint8Array;
          }
        })(),
      kill,
      exited,
    };
  }
}
