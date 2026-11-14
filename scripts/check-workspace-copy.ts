import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SandboxPort } from '../packages/contracts/src/index.js';
import { workspaceCopyScript } from '../packages/core/src/tools/workspace-copy.js';

/** Uses only the supplied Sandbox. No host or alternate-driver fallback. */
export async function checkWorkspaceCopy(sandbox: SandboxPort, signal: AbortSignal): Promise<void> {
  assert(sandbox.execArgv, 'Bounded argv capability is required');
  const root = `copy-acceptance-${randomUUID()}`;
  const created = await sandbox.execArgv(
    'node',
    ['-e', 'require("node:fs").mkdirSync(process.argv[1],{mode:0o700})', root],
    { maxOutputBytes: 1024, signal },
  );
  assert.equal(created.exitCode, 0);
  const source = root + '/source.txt',
    target = root + '/target.txt',
    raced = root + '/raced.txt';
  const run = (destination: string, mode: 'probe' | 'copy') =>
    sandbox.execArgv!('node', ['-e', workspaceCopyScript, source, destination, mode], {
      maxOutputBytes: 1024,
      timeoutMs: 5000,
      signal,
    });
  await sandbox.writeFile(source, 'Copy fixture — 中文');
  assert.equal((await run(target, 'probe')).stdout, 'new');
  assert.equal((await run(target, 'copy')).exitCode, 0);
  assert.equal((await sandbox.readFile(target, { signal })).content, 'Copy fixture — 中文');
  assert.notEqual((await run(target, 'copy')).exitCode, 0);
  assert.equal((await run(raced, 'probe')).stdout, 'new');
  await sandbox.writeFile(raced, 'Preserve raced-in destination');
  assert.notEqual((await run(raced, 'copy')).exitCode, 0);
  assert.equal(
    (await sandbox.readFile(raced, { signal })).content,
    'Preserve raced-in destination',
  );
  const linked = await sandbox.execArgv(
    'node',
    ['-e', 'require("node:fs").symlinkSync("source.txt",process.argv[1])', root + '/link'],
    { maxOutputBytes: 1024, signal },
  );
  assert.equal(linked.exitCode, 0);
  const denied = await sandbox.execArgv(
    'node',
    ['-e', workspaceCopyScript, root + '/link', root + '/unexpected', 'copy'],
    { maxOutputBytes: 1024, signal },
  );
  assert.notEqual(denied.exitCode, 0);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(
    sandbox.execArgv('node', ['-e', workspaceCopyScript, source, root + '/cancelled', 'copy'], {
      maxOutputBytes: 1024,
      signal: stopped.signal,
    }),
  );
  // Leave uniquely named fixture artifacts for inspection. Never delete an
  // uncertain/raced target or retry an effect merely for cleanup.
}
