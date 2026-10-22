import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LocalSandbox } from '../src/index.js';

it.skipIf(process.platform === 'win32')(
  'terminates an owned long-running process group and its child sockets',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-process-group-'));
    await writeFile(
      path.join(root, 'child.cjs'),
      `const server=require('node:net').createServer(socket=>socket.write('ready'));server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`,
    );
    await writeFile(
      path.join(root, 'parent.cjs'),
      String.raw`const child=require('node:child_process').fork('./child.cjs',{silent:true});child.once('message',port=>process.stdout.write(JSON.stringify({port})+'\n'));`,
    );
    const process = new LocalSandbox(root).openProcess('node', ['parent.cjs'], {
      processGroup: true,
    });
    let socket: ReturnType<typeof connect> | undefined;
    try {
      socket = connect({
        host: '127.0.0.1',
        port: await (async () => {
          let text = '';
          for await (const chunk of process.chunks()) {
            text += Buffer.from(chunk).toString();
            if (text.includes('\n')) return (JSON.parse(text) as { port: number }).port;
          }
          throw new Error('Fixture exited before readiness');
        })(),
      });
      const stream = socket;
      await new Promise<void>((resolve, reject) => {
        stream.once('data', () => resolve());
        stream.once('error', reject);
      });
      const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));
      process.kill();
      await Promise.all([process.exited, closed]);
      expect(socket.destroyed).toBe(true);
    } finally {
      process.kill();
      socket?.destroy();
      await rm(root, { recursive: true, force: true });
    }
  },
);
