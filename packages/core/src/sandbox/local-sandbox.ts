import { spawn, execFile } from 'node:child_process';
import { glob as fsGlob } from 'node:fs/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
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
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'USER', 'SHELL']) {
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
    const cwd = opts?.cwd ? this.resolve(opts.cwd) : this.workspaceRoot;
    const signals = [
      AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
      ...(opts?.signal ? [opts.signal] : []),
    ];
    return new Promise<ExecResult>((resolvePromise) => {
      execFile(
        'bash',
        ['-c', command],
        {
          cwd,
          env: this.childEnv(opts?.env),
          signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
          maxBuffer: MAX_BUFFER,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolvePromise({ stdout, stderr, exitCode: 0 });
            return;
          }
          const killed = 'killed' in error && error.killed === true;
          resolvePromise({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? '') || error.message,
            // 124 mirrors `timeout(1)` so callers can distinguish forced kills.
            exitCode: killed ? 124 : typeof error.code === 'number' ? error.code : 1,
          });
        },
      );
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
    const cwd = opts?.cwd ? this.resolve(opts.cwd) : this.workspaceRoot;
    const child = spawn(command, args, {
      cwd,
      env: this.childEnv(opts?.env),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let exitResolve!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exitResolve = resolve;
    });
    child.once('exit', (code) => exitResolve(code));
    child.once('error', () => exitResolve(null));
    opts?.signal?.addEventListener(
      'abort',
      () => {
        child.kill('SIGTERM');
      },
      { once: true },
    );
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
      kill: () => {
        child.kill('SIGTERM');
      },
      exited,
    };
  }
}
