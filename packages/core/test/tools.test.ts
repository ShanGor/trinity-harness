import { describe, expect, it } from 'vitest';

import type { ToolContext } from '@trinity-harness/contracts';

import { bashTool, editFileTool, globTool, readFileTool, writeFileTool } from '../src/index.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

function makeCtx(sandbox: FakeSandbox): ToolContext {
  return { sessionId: 's1', workspaceRoot: '/ws', sandbox };
}

describe('builtin tools over FakeSandbox', () => {
  it('read_file returns content and truncation flag', async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set('a.txt', 'x'.repeat(10));
    const result = await readFileTool.execute({ path: 'a.txt', maxBytes: 4 }, makeCtx(sandbox));
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({ path: 'a.txt', content: 'xxxx', truncated: true });
  });

  it('write_file creates parent content and reports bytes', async () => {
    const sandbox = new FakeSandbox();
    const result = await writeFileTool.execute(
      { path: 'src/b.ts', content: 'hi' },
      makeCtx(sandbox),
    );
    expect(result.value).toEqual({ path: 'src/b.ts', bytes: 2 });
    expect(sandbox.files.get('src/b.ts')).toBe('hi');
  });

  it('edit_file replaces exactly one occurrence', async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set('f.ts', 'const a = 1;\nconst b = 2;');
    const result = await editFileTool.execute(
      { path: 'f.ts', old_text: 'const b = 2;', new_text: 'const b = 3;' },
      makeCtx(sandbox),
    );
    expect(result.value).toEqual({ path: 'f.ts', replacements: 1 });
    expect(sandbox.files.get('f.ts')).toBe('const a = 1;\nconst b = 3;');
  });

  it('edit_file fails when old_text matches zero or multiple locations', async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set('f.ts', 'aa aa');
    await expect(
      editFileTool.execute({ path: 'f.ts', old_text: 'zz', new_text: 'q' }, makeCtx(sandbox)),
    ).rejects.toThrow(/not found/);
    await expect(
      editFileTool.execute({ path: 'f.ts', old_text: 'aa', new_text: 'q' }, makeCtx(sandbox)),
    ).rejects.toThrow(/exactly one|2 locations/);
    expect(sandbox.files.get('f.ts')).toBe('aa aa'); // unchanged
  });

  it('glob lists matching files deterministically', async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set('src/a.ts', '');
    sandbox.files.set('src/b.ts', '');
    sandbox.files.set('README.md', '');
    const result = await globTool.execute({ pattern: 'src/*' }, makeCtx(sandbox));
    expect(result.value).toEqual({ matches: ['src/a.ts', 'src/b.ts'] });
  });

  it('bash reports non-zero exit as isError via the tool', async () => {
    const sandbox = new FakeSandbox();
    sandbox.execHandler = (command) =>
      command === 'ok'
        ? { stdout: 'yes', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'boom', exitCode: 2 };
    const ok = await bashTool.execute({ command: 'ok' }, makeCtx(sandbox));
    expect(ok.isError).toBe(false);
    expect(ok.value).toMatchObject({ stdout: 'yes', exitCode: 0 });
    const bad = await bashTool.execute({ command: 'nope' }, makeCtx(sandbox));
    expect(bad.isError).toBe(true);
    expect(bad.value).toMatchObject({ exitCode: 2 });
  });
});
