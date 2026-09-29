import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { ToolContext } from '@trinity-harness/contracts';

import { createLspTools, LocalSandbox, LspClient, LspService } from '../src/index.js';

/**
 * Real language-server integration tests: actual pyright-langserver /
 * typescript-language-server processes spawned through the production path
 * (LocalSandbox.openProcess → LspConnection → LspClient → LspService).
 *
 * These are environment-dependent: a language without an installed server is
 * skipped entirely (same policy as the distributed e2e tests that skip when
 * PG/Redis are unreachable), so the suite stays deterministic on machines
 * without language servers. AGENTS.md §6's "no real network / LLMs" rule is
 * not violated — both servers are local stdio subprocesses.
 */

/** Resolve a server binary via the user's login PATH (npm-global bins etc.). */
function resolveServer(command: string): string | null {
  for (const argv of [
    ['bash', '-lc'],
    ['sh', '-c'],
  ] as const) {
    const r = spawnSync(argv[0], [argv[1], `command -v ${command}`], { encoding: 'utf8' });
    const found = r.stdout?.trim().split('\n')[0];
    if (found) return found;
  }
  return null;
}

const PYRIGHT = resolveServer('pyright-langserver');
const TSLS = resolveServer('typescript-language-server');

let root = '';
let service: LspService | null = null;

const PY_APP = 'src/app.py';
const TS_APP = 'src/app.ts';
const PY_CLEAN = 'src/clean.py';

afterAll(async () => {
  await service?.dispose();
  service = null;
  if (root) await rm(root, { recursive: true, force: true });
});

/** Fresh temp workspace with a deliberately broken Python file and TS file. */
async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'trinity-lsp-real-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(
    path.join(dir, PY_APP),
    'def greet(name: str) -> str:\n    return "Hello, " + name\n\nx: int = "hello"\n',
  );
  await writeFile(path.join(dir, PY_CLEAN), 'y: int = 1\n');
  await writeFile(
    path.join(dir, TS_APP),
    'function add(a: number, b: number): number {\n  return a + b;\n}\n\nconst n: number = "oops";\n',
  );
  // typescript-language-server resolves `typescript` from the analyzed
  // workspace (and refuses to start otherwise) — link the monorepo's copy.
  const nm = path.join(dir, 'node_modules');
  await mkdir(nm, { recursive: true });
  await symlink(
    path.join(process.cwd(), 'node_modules', 'typescript'),
    path.join(nm, 'typescript'),
  );
  return dir;
}

function makeService(
  dir: string,
  commands?: ConstructorParameters<typeof LspService>[0]['commands'],
) {
  const sandbox = new LocalSandbox(dir);
  const svc = new LspService({
    sandbox,
    readText: (abs) => readFile(abs, 'utf8'),
    ...(commands ? { commands } : {}),
  });
  return { sandbox, svc };
}

function ctx(dir: string, sandbox: LocalSandbox): ToolContext {
  return { sessionId: 's1', workspaceRoot: dir, sandbox };
}

describe('LSP against real language servers', () => {
  describe.runIf(PYRIGHT !== null)('pyright-langserver (python)', () => {
    it('reports real diagnostics, hover, symbols and rename', async () => {
      root = await makeWorkspace();
      const { sandbox, svc } = makeService(root, {
        python: { command: PYRIGHT!, args: ['--stdio'] },
      });
      service = svc;
      await svc.ensureWorkspace(root, ['python']);

      // Diagnostics: pyright flags `x: int = "hello"`.
      const diags = await svc.diagnostics(PY_APP);
      expect(diags.length).toBeGreaterThan(0);
      const err = diags.find((d) => d.severity === 'error');
      expect(err).toBeDefined();
      expect(err!.range.start.line).toBe(3);
      expect(err!.message).toMatch(/str.*not assignable|not assignable.*int/i);

      // Clean file settles to zero diagnostics (not a stale-cache miss).
      expect(await svc.diagnostics(PY_CLEAN)).toEqual([]);

      // Hover on the function name `greet` (line 0, col 5).
      const hover = await svc.hover(PY_APP, { line: 0, character: 5 });
      expect(hover).toBeTruthy();
      expect(hover!).toContain('greet');

      // Workspace symbol search.
      const symbols = await svc.symbols('greet');
      expect(symbols.some((s) => s.name === 'greet' && s.file === PY_APP)).toBe(true);

      // Rename request returns the set of files pyright would touch.
      const edited = await svc.rename(PY_APP, { line: 0, character: 5 }, 'welcome');
      expect(edited).toContain(PY_APP);

      // Tool-level path (what the agent actually invokes).
      const tools = createLspTools(svc);
      const diagTool = tools.find((t) => t.name === 'lsp_diagnostics')!;
      const result = await diagTool.execute(
        diagTool.parameters.parse({ path: PY_APP }),
        ctx(root, sandbox),
      );
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.value)).toMatch(/not assignable/i);

      const hoverTool = tools.find((t) => t.name === 'lsp_hover')!;
      const h = await hoverTool.execute(
        hoverTool.parameters.parse({ path: PY_APP, line: 1, character: 24 }),
        ctx(root, sandbox),
      );
      expect(JSON.stringify(h.value)).toContain('name');
    }, 90_000);

    it('shutdown terminates the server process', async () => {
      const dir = await makeWorkspace();
      const { sandbox, svc } = makeService(dir, {
        python: { command: PYRIGHT!, args: ['--stdio'] },
      });
      const proc = sandbox.openProcess(PYRIGHT!, ['--stdio'], { cwd: dir });
      const client = new LspClient({
        root: dir,
        lang: 'python',
        proc,
        readText: (abs) => readFile(abs, 'utf8'),
      });
      await client.ready;
      await client.shutdown();
      const code = await Promise.race([
        proc.exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000)),
      ]);
      expect(code).not.toBe('timeout');
      await svc.dispose();
      await rm(dir, { recursive: true, force: true });
    }, 90_000);
  });

  describe.runIf(TSLS !== null)('typescript-language-server (typescript)', () => {
    it('reports real diagnostics, hover, symbols and rename', async () => {
      root = await makeWorkspace();
      const { sandbox, svc } = makeService(root, {
        typescript: { command: TSLS!, args: ['--stdio'] },
      });
      service = svc;
      await svc.ensureWorkspace(root, ['typescript']);

      // Diagnostics: `const n: number = "oops"` is a type error.
      const diags = await svc.diagnostics(TS_APP);
      const err = diags.find((d) => d.severity === 'error');
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/'string' is not assignable to type 'number'/);

      // Hover on `add` (line 0, col 10).
      const hover = await svc.hover(TS_APP, { line: 0, character: 10 });
      expect(hover).toBeTruthy();
      expect(hover!).toContain('add');

      // Workspace symbol search.
      const symbols = await svc.symbols('add');
      expect(symbols.some((s) => s.name === 'add' && s.file === TS_APP)).toBe(true);

      // Rename returns files tsserver would edit.
      const edited = await svc.rename(TS_APP, { line: 0, character: 10 }, 'sum');
      expect(edited).toContain(TS_APP);
      void sandbox;
    }, 90_000);
  });
});

// Availability is observable in the run summary: each language describe is
// either "passed" (server installed, real assertions ran) or "skipped".
