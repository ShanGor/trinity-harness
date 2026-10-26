import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RemoteSandbox,
  ZendriverMcpConnection,
  ZendriverBrowserDriver,
  captureBrowserPreview,
} from '../packages/core/src/index.js';
import type {
  EnvironmentRecord,
  GuestEnvelope,
  GuestRequestPort,
} from '../packages/contracts/src/index.js';
import { FirecrackerGuestRelay } from '../apps/node-agent/src/guest-relay.js';

const args = process.argv.slice(2);
const [stateRoot, id, generation, tenantId, userId, sessionId, phase, output] = args;
const flags = args.slice(8);
assert(stateRoot && id && generation && tenantId && userId && sessionId && output);
assert(phase === 'write' || phase === 'read');
const environment: EnvironmentRecord = {
  id,
  generation,
  tenantId,
  userId,
  nodeId: 'development-test',
  state: 'running',
  vcpus: 2,
  memoryMiB: 2048,
};
const relay = new FirecrackerGuestRelay(stateRoot);
const signal = AbortSignal.timeout(90_000);
const envelope = (operation: GuestEnvelope['operation']): GuestEnvelope => ({
  requestId: randomUUID(),
  environmentId: id,
  generation,
  sessionId,
  workspace: 'acceptance',
  operation,
});
const rpc: GuestRequestPort = {
  call: async (_session, operation, abort) =>
    relay.call(environment, envelope(operation), abort ?? signal),
};
const remote = new RemoteSandbox(rpc, sessionId);
const marker = 'Trinity guest persistence verified — 中文';
if (phase === 'write') await remote.writeFile('persistence.txt', marker);
for (const kind of ['read', 'readBytes'] as const) {
  const missing = await rpc.call(
    sessionId,
    {
      kind,
      path: `missing-${randomUUID()}.txt`,
      maxBytes: 100,
    },
    signal,
  );
  assert.deepEqual(
    missing,
    {
      kind: 'operationError',
      operation: kind,
      code: 'FILE_NOT_FOUND',
      effect: 'none',
    },
    'Guest image must support typed file errors; rebuild the guest payload and image.',
  );
}
assert.equal((await remote.readFile('persistence.txt')).content, marker);
console.log(`Guest ${phase}: typed missing-file errors and subsequent healthy read passed.`);
const identity = await remote.execArgv('/usr/bin/id', ['-u'], { signal, maxOutputBytes: 1024 });
assert.equal(identity.exitCode, 0);
assert.equal(identity.stdout.trim(), '1000');
for (const codepoint of ['4e2d', '570b', '3042', 'ac00']) {
  const fonts = await remote.execArgv(
    '/usr/bin/fc-list',
    ['--format=%{file}\\n', `:charset=${codepoint}`],
    { signal, maxOutputBytes: 4096 },
  );
  assert.equal(fonts.exitCode, 0, 'Guest fontconfig is required; rebuild the guest image.');
  assert(fonts.stdout.trim(), `Guest has no font for U+${codepoint}; rebuild with CJK fonts.`);
}
console.log(`Guest ${phase}: Chinese, Japanese and Korean font coverage passed.`);
const secrets = await remote.execArgv(
  '/usr/bin/node',
  [
    '-e',
    'for (const key of ["DATABASE_URL","NODE_RUNTIME_TOKEN","TOKEN_SECRET","OPENAI_API_KEY","ANTHROPIC_API_KEY"]) if (process.env[key]) process.exit(1);',
  ],
  { signal, maxOutputBytes: 1024 },
);
assert.equal(secrets.exitCode, 0);
if (flags.includes('--check-network-denied')) {
  const egress = await remote.execArgv(
    '/usr/bin/python3',
    [
      '-c',
      `import socket
s=socket.socket()
s.settimeout(2)
try:
 s.connect(('1.1.1.1',443))
 print('EGRESS_ALLOWED')
 raise SystemExit(1)
except OSError:
 print('EGRESS_BLOCKED')`,
    ],
    { signal, maxOutputBytes: 1024 },
  );
  assert.equal(egress.exitCode, 0);
  assert.equal(egress.stdout.trim(), 'EGRESS_BLOCKED');
  console.log('Guest external TCP egress denied.');
}
const egressFlag = flags.indexOf('--check-network-egress');
if (egressFlag !== -1) {
  const host = flags[egressFlag + 1];
  const port = flags[egressFlag + 2];
  assert(host && port && /^\d{1,5}$/.test(port));
  const egress = await remote.execArgv(
    '/usr/bin/python3',
    [
      '-c',
      `import socket,sys
connection=socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=10)
connection.close()
print('EGRESS_CONNECTED')`,
      host,
      port,
    ],
    { signal, maxOutputBytes: 1024 },
  );
  assert.equal(egress.exitCode, 0, egress.stderr || egress.stdout);
  assert.equal(egress.stdout.trim(), 'EGRESS_CONNECTED');
  console.log(`Guest DNS/TCP egress to ${host}:${port} passed.`);
}
const skills = await rpc.call(sessionId, { kind: 'skillsList' }, signal);
assert.equal(skills.kind, 'skills');
// A generation mismatch must reach and be rejected by the actual guest, not just the relay.
const staleGeneration = randomUUID();
const staleRoot = path.join(stateRoot, 'jailer/firecracker', staleGeneration);
await mkdir(staleRoot);
await symlink(
  path.join(stateRoot, 'jailer/firecracker', generation, 'root'),
  path.join(staleRoot, 'root'),
);
try {
  await assert.rejects(
    relay.call(
      { ...environment, generation: staleGeneration },
      { ...envelope({ kind: 'skillsList' }), generation: staleGeneration },
      signal,
    ),
    /Guest operation failed/,
  );
} finally {
  await rm(staleRoot, { recursive: true });
}
console.log(
  `Guest ${phase}: workspace persistence, non-root execution, scrubbed environment, skills and stale-generation rejection passed.`,
);

const fixture = remote.openProcess('/usr/bin/node', [
  '-e',
  `
  require('node:http').createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<main><h1>Trinity Firecracker Zendriver</h1><p>Real guest browser — <span lang="zh-CN">中文</span> <span lang="zh-TW">繁體中文</span> <span lang="ja">日本語 あいう</span> <span lang="ko">한국어</span></p></main>');
  }).listen(8765, '127.0.0.1', () => console.log('FIXTURE_READY'));
`,
]);
let connection: ZendriverMcpConnection | undefined;
let ready!: () => void;
const fixtureReady = new Promise<void>((resolve) => {
  ready = resolve;
});
// Keep consuming: closing a RemoteSandbox iterator also terminates its process.
const fixtureOutput = (async (): Promise<void> => {
  let text = '';
  for await (const chunk of fixture.chunks()) {
    text = (text + Buffer.from(chunk).toString('utf8')).slice(-4096);
    if (text.includes('FIXTURE_READY')) ready();
  }
  throw new Error('Guest fixture stopped');
})();
void fixtureOutput.catch(() => undefined);
try {
  await Promise.race([fixtureReady, fixtureOutput]);
  connection = new ZendriverMcpConnection(remote.openBrowser(signal));
  await connection.initialize(signal);
  const driver = new ZendriverBrowserDriver(connection, sessionId, generation, async () => true);
  await driver.open(signal);
  const url = 'http://127.0.0.1:8765/';
  const context = {
    sessionId,
    callId: `guest-${phase}`,
    sandbox: remote,
    workspaceRoot: '/workspace/acceptance',
    signal,
  };
  const binding = await driver.authorize(sessionId, 'navigate', url, signal);
  await driver.navigate(binding, url, context);
  const preview = await captureBrowserPreview(
    driver,
    driver,
    context,
    generation,
    () => new Date(),
  );
  assert.equal(preview.state, 'frame');
  if (preview.state !== 'frame') throw new Error('Missing guest screenshot');
  await writeFile(output, JSON.stringify(preview));
  await writeFile(`${output}.png`, Buffer.from(preview.png, 'base64'));
  console.log(
    `Guest ${phase}: patched Zendriver and Chrome returned a real preview frame; saved to ${output}`,
  );
} finally {
  try {
    await connection?.dispose();
  } finally {
    fixture.kill();
    await fixture.exited;
    await fixtureOutput.catch(() => undefined);
  }
}

const synced = await remote.execArgv('/usr/bin/sync', [], { signal, maxOutputBytes: 1024 });
assert.equal(synced.exitCode, 0);
