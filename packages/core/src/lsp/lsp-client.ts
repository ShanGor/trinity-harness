import { pathToFileURL } from 'node:url';

import type {
  Diagnostic,
  LangId,
  LongRunningProcess,
  Position,
  SymbolInfo,
} from '@trinity-harness/contracts';

import { LspConnection } from './lsp-connection.js';

/** Language-server launch specs (docs/design.md §9). Overridable for tests. */
export const DEFAULT_SERVER_COMMANDS: Record<LangId, { command: string; args: string[] }> = {
  python: { command: 'pyright-langserver', args: ['--stdio'] },
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  json: { command: 'vscode-json-languageserver', args: ['--stdio'] },
  yaml: { command: 'yaml-language-server', args: ['--stdio'] },
};

const DIAGNOSTICS_SETTLE_MS = 2_000;

export interface LspClientOptions {
  root: string;
  lang: LangId;
  proc: LongRunningProcess;
  /** Reads a workspace file as UTF-8 (composition root wires the Sandbox). */
  readText: (absPath: string) => Promise<string>;
}

interface RawDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; // 1=Error 2=Warning 3=Information 4=Hint
  code?: string | number;
  source?: string;
  message: string;
}

const SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;

/**
 * One language-server process + its LSP session (initialize handshake,
 * didOpen tracking, publishDiagnostics cache). Lifecycle is owned by
 * LspService (start on first use, exit on shutdown/dispose).
 */
export class LspClient {
  readonly ready: Promise<void>;
  private readonly conn: LspConnection;
  private readonly diagnosticsByUri = new Map<string, Diagnostic[]>();
  private readonly opened = new Set<string>();
  private readonly notifyWaiters: Array<() => void> = [];

  constructor(readonly opts: LspClientOptions) {
    this.conn = new LspConnection(opts.proc);
    this.conn.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as { uri: string; diagnostics: RawDiagnostic[] };
      const file = this.toFile(p.uri);
      this.diagnosticsByUri.set(
        file,
        p.diagnostics.map((d) => ({
          file,
          range: d.range,
          severity: SEVERITIES[(d.severity ?? 3) - 1] ?? 'information',
          message: d.message,
          ...(d.source !== undefined ? { source: d.source } : {}),
          ...(d.code !== undefined ? { code: String(d.code) } : {}),
        })),
      );
      for (const wake of this.notifyWaiters.splice(0)) wake();
    });
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }

  private async initialize(): Promise<void> {
    await this.conn.request('initialize', {
      processId: null,
      rootUri: pathToFileURL(this.opts.root).href,
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          hover: { contentFormat: ['plaintext', 'markdown'] },
          rename: {},
        },
        workspace: { symbol: {} },
      },
      clientInfo: { name: 'trinity-harness', version: '0.4.0' },
    });
    this.conn.notify('initialized', {});
  }

  private toFile(uri: string): string {
    // file:///abs/path → path relative to the workspace root.
    const prefix = pathToFileURL(this.opts.root).href + '/';
    return uri.startsWith(prefix) ? decodeURIComponent(uri.slice(prefix.length)) : uri;
  }

  private toUri(file: string): string {
    return pathToFileURL(`${this.opts.root.replace(/\/+$/, '')}/${file}`).href;
  }

  private async ensureOpened(file: string): Promise<void> {
    await this.ready;
    const uri = this.toUri(file);
    if (this.opened.has(uri)) return;
    const text = await this.opts.readText(this.absOf(file));
    this.conn.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdOf(this.opts.lang), version: 1, text },
    });
    this.opened.add(uri);
  }

  private absOf(file: string): string {
    return `${this.opts.root.replace(/\/+$/, '')}/${file}`;
  }

  async diagnostics(file: string): Promise<Diagnostic[]> {
    await this.ensureOpened(file);
    // Give the server a brief window to push diagnostics after didOpen.
    await this.waitForDiagnostics(file);
    return this.diagnosticsByUri.get(file) ?? [];
  }

  private async waitForDiagnostics(file: string): Promise<void> {
    if (this.diagnosticsByUri.has(file)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DIAGNOSTICS_SETTLE_MS);
      this.notifyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async symbols(query: string): Promise<SymbolInfo[]> {
    await this.ready;
    const result = (await this.conn.request('workspace/symbol', { query })) as Array<{
      name: string;
      kind: number;
      location: { uri: string; range: SymbolInfo['range'] };
      containerName?: string;
    }> | null;
    const found = (result ?? []).map((s) => ({
      name: s.name,
      kind: symbolKindName(s.kind),
      file: this.toFile(s.location.uri),
      range: s.location.range,
      ...(s.containerName !== undefined ? { containerName: s.containerName } : {}),
    }));
    if (found.length > 0) return found;
    // Fallback: real servers don't always implement workspace/symbol usefully
    // (pyright returns [] in stdio sessions) — flatten the documentSymbol
    // trees of opened docs instead.
    const q = query.toLowerCase();
    const out: SymbolInfo[] = [];
    for (const uri of [...this.opened]) {
      const tree = (await this.conn
        .request('textDocument/documentSymbol', {
          textDocument: { uri },
        })
        .catch(() => null)) as Array<
        | {
            name: string;
            kind: number;
            location: { uri: string; range: SymbolInfo['range'] };
            containerName?: string;
          }
        | {
            name: string;
            kind: number;
            range: SymbolInfo['range'];
            selectionRange?: SymbolInfo['range'];
            children?: unknown[];
          }
      > | null;
      const file = this.toFile(uri);
      const walk = (nodes: unknown[] | undefined, container: string | undefined): void => {
        for (const node of nodes ?? []) {
          const n = node as {
            name: string;
            kind: number;
            location?: { uri: string; range: SymbolInfo['range'] };
            range?: SymbolInfo['range'];
            selectionRange?: SymbolInfo['range'];
            children?: unknown[];
          };
          if (q === '' || n.name.toLowerCase().includes(q)) {
            out.push({
              name: n.name,
              kind: symbolKindName(n.kind),
              file,
              range: n.selectionRange ?? n.range ?? n.location!.range,
              ...(container !== undefined ? { containerName: container } : {}),
            });
          }
          walk(n.children, n.name);
        }
      };
      walk(tree ?? undefined, undefined);
    }
    return out;
  }

  async hover(file: string, position: Position): Promise<string | null> {
    await this.ensureOpened(file);
    const result = (await this.conn.request('textDocument/hover', {
      textDocument: { uri: this.toUri(file) },
      position,
    })) as { contents: { value?: string } | Array<{ value?: string }> } | null;
    if (!result) return null;
    const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
    const text = contents
      .map((c) => (typeof c === 'object' && c !== null ? (c.value ?? '') : String(c)))
      .filter((s) => s.length > 0)
      .join('\n');
    return text.length > 0 ? text : null;
  }

  async rename(file: string, position: Position, newName: string): Promise<string[]> {
    await this.ensureOpened(file);
    const result = (await this.conn.request(
      'textDocument/rename',
      { textDocument: { uri: this.toUri(file) }, position, newName },
      60_000,
    )) as {
      changes?: Record<string, unknown[]>;
      documentChanges?: Array<{ textDocument?: { uri?: string } }>;
    } | null;
    // Servers return one of two shapes: legacy `changes` keyed by URI, or
    // LSP 3.16+ `documentChanges` (pyright / tsserver use the latter).
    const edited: string[] = [];
    if (result?.changes) {
      for (const [uri, edits] of Object.entries(result.changes)) {
        if (Array.isArray(edits) && edits.length > 0) edited.push(this.toFile(uri));
      }
    }
    for (const change of result?.documentChanges ?? []) {
      const uri = change.textDocument?.uri;
      if (uri) edited.push(this.toFile(uri));
    }
    return [...new Set(edited)];
  }

  async shutdown(): Promise<void> {
    try {
      await this.conn.request('shutdown', {}, 5_000);
      this.conn.notify('exit', {});
    } catch {
      // Already dead — kill below still applies.
    }
    this.opts.proc.kill();
  }
}

export function languageIdOf(lang: LangId): string {
  switch (lang) {
    case 'python':
      return 'python';
    case 'typescript':
      return 'typescript';
    case 'json':
      return 'json';
    case 'yaml':
      return 'yaml';
  }
}

const SYMBOL_KINDS = [
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
];

function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind - 1] ?? `Kind${kind}`;
}
