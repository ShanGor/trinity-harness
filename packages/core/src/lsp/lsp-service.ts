import path from 'node:path';

import type {
  Diagnostic,
  LangId,
  LSPPort,
  Position,
  SandboxPort,
  SymbolInfo,
} from '@trinity-harness/contracts';

import { DEFAULT_SERVER_COMMANDS, LspClient } from './lsp-client.js';

/** File extension → language (docs/design.md §9: Python/TS/JSON/YAML). */
const EXT_TO_LANG: Record<string, LangId> = {
  '.py': 'python',
  '.pyi': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

export function langOfFile(file: string): LangId | null {
  return EXT_TO_LANG[path.extname(file).toLowerCase()] ?? null;
}

export interface LspServiceOptions {
  /** Spawns language servers (composition root wires the Sandbox). */
  sandbox: SandboxPort;
  /**
   * Reads a workspace-ABSOLUTE file as UTF-8. Wired to the Sandbox in the
   * composition root so file access stays behind the port (AGENTS.md §5).
   */
  readText: (absPath: string) => Promise<string>;
  /** Per-language launch overrides (tests inject fake servers here). */
  commands?: Partial<Record<LangId, { command: string; args: string[] }>> | undefined;
  /** Per-pod LSP process ceiling (design.md §9 伸缩考虑); LRU beyond this. */
  maxServers?: number | undefined;
}

interface ServerKey {
  root: string;
  lang: LangId;
}

/**
 * LSP Service (docs/design.md §5.1/§9): owns the per-workspace language-
 * server process pool — lazy start keyed by (root, lang), LRU eviction at
 * `maxServers`, deterministic shutdown via `dispose()`.
 */
export class LspService implements LSPPort {
  private readonly clients = new Map<string, LspClient>();
  private readonly lru: string[] = [];
  private readonly starting = new Map<string, Promise<LspClient>>();
  private readonly workspaces = new Map<string, Set<LangId>>();
  private readonly maxServers: number;

  constructor(private readonly opts: LspServiceOptions) {
    this.maxServers = Math.max(1, opts.maxServers ?? 4);
  }

  async ensureWorkspace(root: string, langs: LangId[]): Promise<void> {
    const set = this.workspaces.get(root) ?? new Set<LangId>();
    for (const lang of langs) set.add(lang);
    this.workspaces.set(root, set);
  }

  async diagnostics(file: string): Promise<Diagnostic[]> {
    const client = await this.clientFor(file);
    if (!client) return [];
    return client.diagnostics(file);
  }

  async symbols(query: string): Promise<SymbolInfo[]> {
    const results = await Promise.all(
      [...this.clients.values()].map((client) => client.symbols(query).catch(() => [])),
    );
    return results.flat();
  }

  async hover(file: string, position: Position): Promise<string | null> {
    const client = await this.clientFor(file);
    if (!client) return null;
    return client.hover(file, position);
  }

  async rename(file: string, position: Position, newName: string): Promise<string[]> {
    const client = await this.clientFor(file);
    if (!client) return [];
    return client.rename(file, position, newName);
  }

  async shutdown(root: string): Promise<void> {
    const langs = this.workspaces.get(root) ?? new Set<LangId>();
    for (const lang of langs) {
      const key = this.key({ root, lang });
      const client = this.clients.get(key);
      this.clients.delete(key);
      this.dropFromLru(key);
      this.starting.delete(key);
      if (client) await client.shutdown().catch(() => {});
    }
    this.workspaces.delete(root);
  }

  /** Deterministic shutdown of every language server (AGENTS.md §4.2). */
  async dispose(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    this.lru.length = 0;
    this.starting.clear();
    this.workspaces.clear();
    await Promise.all(all.map((client) => client.shutdown().catch(() => {})));
  }

  /** Lazy (root, lang-of-file) client with single-flight start + LRU. */
  private async clientFor(file: string): Promise<LspClient | null> {
    const lang = langOfFile(file);
    if (!lang) return null;
    const root = this.rootFor(file);
    if (!root) return null;
    const key = this.key({ root, lang });
    const existing = this.clients.get(key);
    if (existing) {
      this.touch(key);
      return existing;
    }
    let starting = this.starting.get(key);
    if (!starting) {
      starting = this.start(key, { root, lang });
      this.starting.set(key, starting);
    }
    let client: LspClient;
    try {
      client = await starting;
    } finally {
      this.starting.delete(key);
    }
    this.touch(key);
    await this.evictIfNeeded();
    return client;
  }

  private async start(key: string, where: ServerKey): Promise<LspClient> {
    const spec = this.opts.commands?.[where.lang] ?? DEFAULT_SERVER_COMMANDS[where.lang];
    const proc = this.opts.sandbox.openProcess(spec.command, spec.args, { cwd: where.root });
    const client = new LspClient({
      root: where.root,
      lang: where.lang,
      proc,
      readText: this.opts.readText,
    });
    this.clients.set(key, client);
    try {
      await client.ready;
    } catch (err) {
      this.clients.delete(key);
      proc.kill();
      throw new Error(
        `failed to start ${spec.command} for ${where.lang}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return client;
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.clients.size > this.maxServers) {
      const oldest = this.lru.shift();
      if (!oldest) return;
      const client = this.clients.get(oldest);
      this.clients.delete(oldest);
      if (client) await client.shutdown().catch(() => {});
    }
  }

  private touch(key: string): void {
    this.dropFromLru(key);
    this.lru.push(key);
  }

  private dropFromLru(key: string): void {
    const i = this.lru.indexOf(key);
    if (i !== -1) this.lru.splice(i, 1);
  }

  /**
   * Resolves the workspace root for a file: absolute paths must be contained
   * in a registered root; workspace-relative paths belong to the (longest)
   * registered root.
   */
  private rootFor(file: string): string | null {
    if (!file.startsWith('/')) {
      let best: string | null = null;
      for (const root of this.workspaces.keys()) {
        if (best === null || root.length > best.length) best = root;
      }
      return best;
    }
    let best: string | null = null;
    for (const root of this.workspaces.keys()) {
      if (file.startsWith(`${root.replace(/\/+$/, '')}/`)) {
        if (best === null || root.length > best.length) best = root;
      }
    }
    return best;
  }

  private key(k: ServerKey): string {
    return `${k.root}|${k.lang}`;
  }
}
