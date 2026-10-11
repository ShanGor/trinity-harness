import type {
  ArgvExecOptions,
  BoundedExecResult,
  EditFileResult,
  ExecResult,
  LongRunningProcess,
  OpenProcessOptions,
  ReadFileResult,
  SandboxPort,
} from '@trinity-harness/contracts';

/**
 * In-memory SandboxPort for tests (AGENTS.md §6: no real FS/processes).
 * Bash "commands" are resolved by an injected handler, defaulting to a
 * deterministic not-implemented failure.
 */
export class FakeSandbox implements SandboxPort {
  readonly files = new Map<string, string>();
  readonly binaryFiles = new Map<string, Uint8Array>();
  async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    const bytes = this.binaryFiles.get(path);
    if (!bytes || bytes.length > maxBytes) throw new Error('binary file unavailable');
    return bytes;
  }
  async removeFile(path: string): Promise<void> {
    this.binaryFiles.delete(path);
  }
  execHandler: (command: string) => ExecResult = (command) => ({
    stdout: '',
    stderr: `FakeSandbox: no handler for: ${command}`,
    exitCode: 127,
  });

  resolve(p: string): string {
    return p;
  }

  async exec(command: string): Promise<ExecResult> {
    return this.execHandler(command);
  }

  argvHandler:
    | ((command: string, args: string[], opts: ArgvExecOptions) => Promise<BoundedExecResult>)
    | undefined;

  async execArgv(
    command: string,
    args: string[],
    opts: ArgvExecOptions,
  ): Promise<BoundedExecResult> {
    if (!this.argvHandler) throw new Error('FakeSandbox: no bounded argv handler');
    return this.argvHandler(command, args, opts);
  }

  async readFile(path: string, opts?: { maxBytes?: number }): Promise<ReadFileResult> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    const maxBytes = opts?.maxBytes ?? 100_000;
    return {
      content: content.slice(0, maxBytes),
      truncated: content.length > maxBytes,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async editFile(path: string, oldText: string, newText: string): Promise<EditFileResult> {
    const { content } = await this.readFile(path);
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`edit_file: old_text not found in ${path}`);
    }
    if (occurrences > 1) {
      throw new Error(`edit_file: old_text matches ${occurrences} locations in ${path}`);
    }
    const updated = content.replace(oldText, newText);
    this.files.set(path, updated);
    return { content: updated, replacements: 1 };
  }

  async glob(pattern: string): Promise<string[]> {
    // Minimal test double: "*" suffix match on stored paths.
    const prefix = pattern.replace(/\*+$/, '');
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  /**
   * Test hook: when set, receives openProcess() calls (fake language servers
   * in LSP tests); otherwise spawning fails deterministically.
   */
  processHandler: ((command: string, args: string[]) => LongRunningProcess) | undefined = undefined;

  openProcess(command: string, args: string[], opts?: OpenProcessOptions): LongRunningProcess {
    void opts;
    if (!this.processHandler) {
      throw new Error(`FakeSandbox: no process handler for: ${command} ${args.join(' ')}`);
    }
    return this.processHandler(command, args);
  }
}
