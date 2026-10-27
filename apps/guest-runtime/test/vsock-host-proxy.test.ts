import { execFileSync, spawn } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The guest is Linux-only. Compile the actual guard and exercise its peer check;
// the real Firecracker transport must additionally be checked in a guest.
describe.skipIf(process.platform !== 'linux')('guest host-only vsock proxy', () => {
  let directory: string;
  let binary: string;
  let harness: string;
  let server: Server | undefined;
  let client: Socket | undefined;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'trinity-vsock-guard-'));
    binary = path.join(directory, 'guard');
    harness = path.join(directory, 'peer-check');
    const source = fileURLToPath(
      new URL('../../../deploy/firecracker/guest/vsock-host-proxy.c', import.meta.url),
    );
    const testSource = path.join(directory, 'peer-check.c');
    await writeFile(
      testSource,
      `
#define main proxy_main
#include ${JSON.stringify(source)}
#undef main
int main(void) {
  struct sockaddr_vm peer;
  memset(&peer, 0, sizeof(peer));
  peer.svm_family = AF_VSOCK;
  peer.svm_cid = VMADDR_CID_HOST;
  if (!allowed_peer(&peer, sizeof(peer))) return 1;
  if (allowed_peer(&peer, sizeof(peer) - 1)) return 2;
  peer.svm_cid = 3;
  if (allowed_peer(&peer, sizeof(peer))) return 3;
  peer.svm_cid = VMADDR_CID_HOST;
  peer.svm_family = AF_UNIX;
  if (allowed_peer(&peer, sizeof(peer))) return 4;
  return 0;
}
`,
    );
    for (const [input, output] of [
      [source, binary],
      [testSource, harness],
    ] as const)
      execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', input, '-o', output]);
  });
  afterAll(async () => {
    client?.destroy();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('accepts only the kernel-reported host CID and complete vsock address', () => {
    expect(() => execFileSync(harness)).not.toThrow();
  });
  it('rejects an ordinary Unix socket before opening the private browser socket', async () => {
    const socketPath = path.join(directory, 'untrusted.sock');
    const childExited = new Promise<number | null>((resolve, reject) => {
      server = createServer((socket) => {
        const child = spawn(binary, [], { stdio: [socket, socket, 'ignore'] });
        child.once('error', reject);
        child.once('exit', (code) => {
          socket.destroy();
          resolve(code);
        });
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    client = connect(socketPath);
    await once(client, 'connect');
    expect(await childExited).toBe(77);
  });
});
