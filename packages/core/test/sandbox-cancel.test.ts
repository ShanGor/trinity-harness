import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSandbox } from '../src/index.js';

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) throw err;
  }
}

// Process integration: readiness is an IPC/file event, not a timing delay.
describe.skipIf(process.platform === 'win32')('LocalSandbox cancellation', () => {
  it('terminates the shell command and its child process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-cancel-process-'));
    const controller = new AbortController();
    let observedChild: number | undefined;
    await writeFile(
      path.join(root, 'child.cjs'),
      `require('node:net').createServer().listen(0,'127.0.0.1',()=>process.send('ready'));`,
    );
    await writeFile(
      path.join(root, 'parent.cjs'),
      `
      const child=require('node:child_process').fork('./child.cjs',{silent:true});
      process.on('SIGTERM',()=>child.once('exit',()=>process.exit(0)));
      child.once('message',()=>{const fs=require('node:fs');fs.writeFileSync('ready.tmp',JSON.stringify({pid:child.pid}));fs.renameSync('ready.tmp','ready.json');});
    `,
    );
    let started!: () => void;
    const readiness = new Promise<void>((resolve) => {
      started = resolve;
    });
    const watcher = watch(root, (_event, filename) => {
      if (filename === 'ready.json') started();
    });
    try {
      const sandbox = new LocalSandbox(root);
      const task = sandbox.exec('node parent.cjs', { signal: controller.signal });
      await readiness;
      observedChild = (
        JSON.parse(await readFile(path.join(root, 'ready.json'), 'utf8')) as { pid: number }
      ).pid;
      controller.abort();
      expect((await task).exitCode).toBe(124);
      // The parent reaps its child before exiting; there is no surviving child.
      expect(() => process.kill(observedChild!, 0)).toThrow();
    } finally {
      controller.abort();
      watcher.close();
      if (observedChild) killIfAlive(observedChild);
      await rm(root, { recursive: true, force: true });
    }
  });
});
