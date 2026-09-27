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

export interface ReadFileResult {
  content: string;
  truncated: boolean;
}

export interface EditFileResult {
  content: string;
  /** Number of replacements applied (M1 semantics: exactly 1). */
  replacements: number;
}

export interface SandboxPort {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string, opts?: { maxBytes?: number }): Promise<ReadFileResult>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * str-replace semantics (design.md §8): exactly one occurrence must match,
   * otherwise the call fails — forces read-before-edit precision.
   */
  editFile(path: string, oldText: string, newText: string): Promise<EditFileResult>;
  /** Glob patterns resolved relative to the workspace root. */
  glob(pattern: string): Promise<string[]>;
}
