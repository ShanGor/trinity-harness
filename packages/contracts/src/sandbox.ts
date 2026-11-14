import { z } from 'zod';

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

export const readFileCursorSchema = z
  .object({
    byteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    lineByteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const readFileOptionsSchema = z
  .object({
    maxBytes: z
      .number()
      .int()
      .min(4)
      .max(1024 * 1024)
      .optional(),
    offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().positive().max(2000).optional(),
    cursor: readFileCursorSchema.optional(),
  })
  .strict()
  .refine((value) => value.cursor === undefined || value.offset === undefined, {
    message: 'Use cursor or offset, not both',
  });
export type ReadFileOptions = z.infer<typeof readFileOptionsSchema> & { signal?: AbortSignal };
export const readFileResultSchema = z
  .object({
    content: z.string(),
    truncated: z.boolean(),
    offset: z.number().int().positive(),
    nextOffset: z.number().int().positive().optional(),
    totalLines: z.number().int().nonnegative().optional(),
    continuation: readFileCursorSchema.optional(),
    startsMidLine: z.boolean().optional(),
    endsMidLine: z.boolean().optional(),
  })
  .strict();
export type ReadFileResult = z.infer<typeof readFileResultSchema>;

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

/** Bounded immediate directory listing for the human workspace viewer. */
export const workspacePathSchema = z
  .string()
  .max(1000)
  .refine(
    (value) =>
      value === '' ||
      (!value.includes('\\') &&
        !value.includes('\0') &&
        value
          .split('/')
          .every(
            (part) => part !== '' && part !== '.' && part !== '..' && part !== 'model-context',
          )),
  );
export const workspaceDirectorySchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255),
            kind: z.enum(['file', 'directory', 'other']),
          })
          .strict(),
      )
      .max(500),
    truncated: z.boolean(),
  })
  .strict();
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;

export const workspaceDocumentRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('read'),
      path: workspacePathSchema,
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z.object({ operation: z.literal('history'), path: workspacePathSchema }).strict(),
  z
    .object({
      operation: z.literal('save'),
      path: workspacePathSchema,
      expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
      content: z.string().max(5 * 1024 * 1024),
    })
    .strict(),
]);
export type WorkspaceDocumentRequest = z.infer<typeof workspaceDocumentRequestSchema>;
export const workspaceDocumentSchema = z
  .object({
    isText: z.boolean().optional(),
    version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    base64: z
      .string()
      .max(7 * 1024 * 1024)
      .optional(),
    text: z
      .string()
      .max(5 * 1024 * 1024)
      .optional(),
    revisions: z
      .array(
        z.object({ version: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.string() }).strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export type WorkspaceDocument = z.infer<typeof workspaceDocumentSchema>;

export interface SandboxPort {
  workspaceDocument?(
    request: WorkspaceDocumentRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument>;
  /** Human-only bounded preview; adapters may use the existing guest argv protocol. */
  previewFile?(path: string, signal?: AbortSignal): Promise<ReadFileResult>;
  listDirectory?(path: string, signal?: AbortSignal): Promise<WorkspaceDirectory>;
  /** Bind one tool invocation cancellation to every remote I/O operation. */
  withSignal?(signal?: AbortSignal): SandboxPort;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** No shell. Missing support must fail closed for bounded browser capture. */
  execArgv?(command: string, args: string[], opts: ArgvExecOptions): Promise<BoundedExecResult>;
  readFile(path: string, opts?: ReadFileOptions): Promise<ReadFileResult>;
  /** Bounded binary capture transfer; implementations reject symlinks and oversize files. */
  readBytes?(path: string, maxBytes: number): Promise<Uint8Array>;
  writeBytes?(path: string, content: Uint8Array): Promise<void>;
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
