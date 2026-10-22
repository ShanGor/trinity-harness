/**
 * Sandbox port (docs/design.md §12.3): the ONLY allowed path for process
 * spawning and filesystem effects from tools. Worker/business code must not
 * touch child_process directly; the M1 local adapter encapsulates it.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  /** Hard cap on runtime; implementations must abort past it. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ArgvExecOptions extends ExecOptions {
  /** Combined stdout/stderr UTF-8 transport cap, enforced while consuming chunks. */
  maxOutputBytes: number;
}

export interface BoundedExecResult extends ExecResult {
  outputOverflow: boolean;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
}

export interface EditFileResult {
  content: string;
  /** Number of replacements applied (M1 semantics: exactly 1). */
  replacements: number;
}

/**
 * A long-running child process with a raw stdio byte duplex (M4: language
 * servers speak LSP's Content-Length-framed JSON-RPC over stdio). Spawned
 * exclusively via the Sandbox port — business code never touches
 * child_process (AGENTS.md §5). Framing (NDJSON vs LSP headers) is the
 * caller's concern.
 */
export interface LongRunningProcess {
  write(data: Uint8Array): void;
  /** stdout byte chunks (arbitrary fragmentation). */
  chunks(): AsyncIterable<Uint8Array>;
  kill(): void;
  /** Resolves when the process exits (or already has). */
  exited: Promise<number | null>;
}

export interface OpenProcessOptions {
  /** Dedicated POSIX process group; kill() terminates all owned descendants. */
  processGroup?: boolean;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}

export interface SandboxPort {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** No shell. Missing support must fail closed for bounded browser capture. */
  execArgv?(command: string, args: string[], opts: ArgvExecOptions): Promise<BoundedExecResult>;
  readFile(path: string, opts?: { maxBytes?: number }): Promise<ReadFileResult>;
  /** Bounded binary capture transfer; implementations reject symlinks and oversize files. */
  readBytes?(path: string, maxBytes: number): Promise<Uint8Array>;
  removeFile?(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * str-replace semantics (design.md §8): exactly one occurrence must match,
   * otherwise the call fails — forces read-before-edit precision.
   */
  editFile(path: string, oldText: string, newText: string): Promise<EditFileResult>;
  /** Glob patterns resolved relative to the workspace root. */
  glob(pattern: string): Promise<string[]>;
  /**
   * Spawn a long-running process (M4 LSP, docs/design.md §9). The caller owns
   * deterministic shutdown via `kill()`; implementations must reap the child.
   */
  openProcess(command: string, args: string[], opts?: OpenProcessOptions): LongRunningProcess;
}
