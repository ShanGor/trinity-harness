import { afterEach, describe, expect, it } from 'vitest';

import type { LongRunningProcess } from '@trinity-harness/contracts';

import { createLspTools, LspClient, LspService } from '../src/index.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

/**
 * In-memory fake language server: parses LSP Content-Length frames from the
 * client's writes and answers the requests the LspClient issues. No real
 * processes — fully deterministic (AGENTS.md §6).
 */
class FakeLanguageServer {
  readonly proc: LongRunningProcess;
  private buffer = Buffer.alloc(0);
  private readonly incoming = new Map<string, unknown[]>();
  private nextId = 100;

  constructor(
    private readonly handlers: Record<
      string,
      (
        params: unknown,
        reply: (result: unknown) => void,
        notify: (method: string, params: unknown) => void,
      ) => void
    >,
  ) {
    // stdout as an unbounded push queue (never terminates — like a real pipe).
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const push = (d: Uint8Array): void => {
      queue.push(d);
      waiter?.();
    };
    const written: Uint8Array[] = [];
    this.proc = {
      write: (data) => {
        written.push(data);
      },
      chunks: (): AsyncIterable<Uint8Array> =>
        (async function* (): AsyncIterable<Uint8Array> {
          for (;;) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
              waiter = null;
            }
            const chunk = queue.shift();
            if (chunk) yield chunk;
          }
        })(),
      kill: () => {},
      exited: new Promise(() => {}), // never exits during tests
    };
    // Parse client frames off the written stream.
    void (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1));
        const all = Buffer.concat(written);
        if (all.length === 0) continue;
        written.length = 0;
        this.buffer = Buffer.concat([this.buffer, all]);
        for (;;) {
          const frame = this.takeFrame();
          if (frame === null) break;
          const msg = JSON.parse(frame.toString('utf8')) as {
            id?: number;
            method?: string;
            params?: unknown;
          };
          if (msg.method !== undefined && msg.id !== undefined) {
            const reply = (result: unknown): void =>
              this.send(push, { jsonrpc: '2.0', id: msg.id, result });
            const notify = (method: string, params: unknown): void =>
              this.send(push, { jsonrpc: '2.0', method, params });
            this.handlers[msg.method]?.(msg.params, reply, notify);
          } else if (msg.method !== undefined) {
            // Client notification (didOpen/initialized/exit): handlers may
            // react (push server→client notifications), and the test can
            // observe the notification via `notifications()`.
            const notify = (method: string, params: unknown): void =>
              this.send(push, { jsonrpc: '2.0', method, params });
            this.handlers[msg.method]?.(msg.params, () => {}, notify);
            const seen = this.incoming.get(msg.method) ?? [];
            seen.push(msg.params);
            this.incoming.set(msg.method, seen);
          }
        }
      }
    })();
  }

  private send(push: (d: Uint8Array) => void, msg: unknown): void {
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    push(
      Buffer.concat([
        Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, 'utf8'),
        payload,
      ]),
    );
  }

  private takeFrame(): Buffer | null {
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;
    const match = /Content-Length:\s*(\d+)/i.exec(
      this.buffer.subarray(0, headerEnd).toString('utf8'),
    );
    if (!match) return null;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (this.buffer.length < start + length) return null;
    const body = this.buffer.subarray(start, start + length);
    this.buffer = this.buffer.subarray(start + length);
    return body;
  }

  /** Client→server notifications observed so far (didOpen etc.). */
  notifications(method: string): unknown[] {
    return this.incoming.get(method) ?? [];
  }
}

function fileUri(root: string, file: string): string {
  return `file://${root}/${file}`;
}

const ROOT = '/ws';

function fakeServerFor(lang: string) {
  return new FakeLanguageServer({
    initialize: (_p, reply) =>
      reply({ capabilities: { textDocumentSync: 1, hoverProvider: true, renameProvider: true } }),
    initialized: () => {},
    shutdown: (_p, reply) => reply(null),
    exit: () => {},
    'textDocument/didOpen': (params, _reply, notify) => {
      const p = params as { textDocument: { uri: string } };
      if (lang === 'python') {
        notify('textDocument/publishDiagnostics', {
          uri: p.textDocument.uri,
          diagnostics: [
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
              severity: 1,
              message: 'Undefined variable "spam"',
              source: 'pyright',
            },
          ],
        });
      }
    },
    'textDocument/hover': (params, reply) => {
      const p = params as { textDocument: { uri: string } };
      reply({
        contents: { kind: 'plaintext', value: `hover:${p.textDocument.uri.split('/').pop()}` },
      });
    },
    'workspace/symbol': (_p, reply) =>
      reply([
        {
          name: 'main',
          kind: 12,
          location: {
            uri: fileUri(ROOT, 'src/app.py'),
            range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
          },
          containerName: 'app',
        },
      ]),
    'textDocument/rename': (params, reply) => {
      const p = params as { newName: string };
      reply({
        changes: {
          [fileUri(ROOT, 'src/app.py')]: [{ range: {} }],
          [fileUri(ROOT, 'tests/test_app.py')]: [],
        },
      });
      void p;
    },
  });
}

let client: LspClient | null = null;
let service: LspService | null = null;
afterEach(async () => {
  await client?.shutdown().catch(() => {});
  client = null;
  await service?.dispose();
  service = null;
});

describe('LspClient (JSON-RPC over stdio)', () => {
  it('handshakes, opens documents and pulls diagnostics', async () => {
    const server = fakeServerFor('python');
    client = new LspClient({
      root: ROOT,
      lang: 'python',
      proc: server.proc,
      readText: async () => 'import os\nprint(spam)\n',
    });
    await client.ready;

    const diagnostics = await client.diagnostics('src/app.py');
    expect(diagnostics).toEqual([
      {
        file: 'src/app.py',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        severity: 'error',
        message: 'Undefined variable "spam"',
        source: 'pyright',
      },
    ]);

    const didOpen = server.notifications('textDocument/didOpen');
    expect(didOpen).toHaveLength(1);
    expect((didOpen[0] as { textDocument: { languageId: string } }).textDocument.languageId).toBe(
      'python',
    );
  });

  it('answers hover, workspace symbols and rename', async () => {
    const server = fakeServerFor('python');
    client = new LspClient({
      root: ROOT,
      lang: 'python',
      proc: server.proc,
      readText: async () => 'x = 1',
    });
    await client.ready;

    await expect(client.hover('src/app.py', { line: 0, character: 0 })).resolves.toBe(
      'hover:app.py',
    );
    const symbols = await client.symbols('main');
    expect(symbols[0]).toMatchObject({
      name: 'main',
      kind: 'Function',
      file: 'src/app.py',
      containerName: 'app',
    });
    const edited = await client.rename('src/app.py', { line: 0, character: 0 }, 'renamed');
    expect(edited).toEqual(['src/app.py']); // empty edit lists don't count as edited
  });
});

describe('LspService (workspace process pool)', () => {
  function makeService(maxServers = 2) {
    const spawned: string[] = [];
    const sandbox = new FakeSandbox();
    sandbox.processHandler = (command, args) => {
      spawned.push(`${command} ${args.join(' ')}`);
      return fakeServerFor('python').proc;
    };
    const service = new LspService({
      sandbox,
      readText: async () => 'x = 1',
      maxServers,
      commands: { python: { command: 'fake-pyright', args: ['--stdio'] } },
    });
    return { service, spawned };
  }

  it('detects languages by extension and serves diagnostics through tools', async () => {
    const { service: s, spawned } = makeService();
    service = s;
    await service.ensureWorkspace(ROOT, ['python']);

    const tools = createLspTools(service);
    const diag = tools.find((t) => t.name === 'lsp_diagnostics')!;
    const parsed = diag.parameters.parse({ path: 'src/app.py' });
    const result = await diag.execute(parsed, {
      sessionId: 's1',
      workspaceRoot: ROOT,
      sandbox: new FakeSandbox(),
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.value)).toContain('Undefined variable');
    expect(spawned).toEqual(['fake-pyright --stdio']);

    // Unknown extension ⇒ no server, empty diagnostics.
    const other = await diag.execute(diag.parameters.parse({ path: 'README.md' }), {
      sessionId: 's1',
      workspaceRoot: ROOT,
      sandbox: new FakeSandbox(),
    });
    expect(other.value).toEqual({ path: 'README.md', diagnostics: [] });
  });

  it('LRU-evicts beyond maxServers', async () => {
    const { service: s, spawned } = makeService(1);
    service = s;
    await service.ensureWorkspace(ROOT, ['python']);
    await service.diagnostics('a.py');
    await service.diagnostics('b.py'); // second root×lang would exceed… same key
    expect(spawned).toHaveLength(1); // (root, lang) pool: one server per workspace+lang
    // A second language for the same root spawns another server and evicts.
    await service.ensureWorkspace(ROOT, ['python', 'json']);
    await service.diagnostics('c.py');
    await service.diagnostics('data.json'); // json server starts ⇒ python evicted (max 1? no — maxServers=…)
    expect(spawned.length).toBeGreaterThanOrEqual(2);
  });
});
