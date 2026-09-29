/**
 * LSP port (docs/design.md §5.2, §9): language services are exposed to the
 * Loop as `lsp_*` tools and as automatic diagnostics context. Implementations
 * own the language-server process pool (per workspace root, lazy start, LRU
 * eviction) and MUST provide a deterministic shutdown via `dispose()`.
 */

export type LangId = 'python' | 'typescript' | 'json' | 'yaml';

export interface Position {
  /** 0-based line. */
  line: number;
  /** 0-based character offset in the line (UTF-16 code units). */
  character: number;
}

export interface Diagnostic {
  file: string;
  range: { start: Position; end: Position };
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  file: string;
  range: { start: Position; end: Position };
  containerName?: string;
}

export interface LSPPort {
  /**
   * Lazily starts language servers for `langs` under `root` (idempotent).
   * The root is a workspace-absolute path (NOT sandbox-relative).
   */
  ensureWorkspace(root: string, langs: LangId[]): Promise<void>;
  /** Pull diagnostics for one file (workspace-relative path). */
  diagnostics(file: string): Promise<Diagnostic[]>;
  /** Workspace-wide symbol search. */
  symbols(query: string): Promise<SymbolInfo[]>;
  /** Hover documentation at a position; null when the server has nothing. */
  hover(file: string, position: Position): Promise<string | null>;
  /** Rename a symbol at a position; returns the list of edited files. */
  rename(file: string, position: Position, newName: string): Promise<string[]>;
  /** Stop all language servers for a workspace root. */
  shutdown(root: string): Promise<void>;
  /** Deterministic shutdown of every language server (AGENTS.md §4.2). */
  dispose(): Promise<void>;
}
