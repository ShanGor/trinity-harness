import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
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
import { buildNodeAgent } from '../apps/node-agent/src/server.js';
import { checkGuestDesktopHandoff } from './firecracker-desktop-handoff.js';
import { PgBrowserInteractionStore, PgBrowserRuntimeStore } from '../packages/db/src/index.js';
import { guestResponseSchema } from '../packages/contracts/src/index.js';

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
const desktopEnabled = flags.includes('--desktop');
const token = randomUUID() + randomUUID();
const nodeAgent =
  desktopEnabled && process.env['TRINITY_GUEST_PG_TEST'] === '1'
    ? buildNodeAgent(
        {
          command: async () => {
            throw new Error('Unexpected runtime command');
          },
        },
        {
          authorizeNode: async () => true,
          runShared: async (_identity, action, active) => action(active ?? signal),
        },
        environment.nodeId!,
        token,
        {
          relay,
          metas: {
            get: async () => ({
              id: sessionId,
              userId,
              tenantId,
              title: '',
              kind: 'work',
              scope: 'personal',
              workspaceUri: '/workspace/acceptance',
              createdAt: '2026-01-01T00:00:00Z',
            }),
          },
          users: {
            findById: async () => ({
              id: userId,
              tenantId,
              role: 'developer',
              email: 'fixture@example.com',
              createdAt: '2026-01-01T00:00:00Z',
            }),
          },
          workspaceRoot: '/workspace',
        },
      )
    : undefined;
if (nodeAgent) {
  const unauthorized = await nodeAgent.inject({
    method: 'POST',
    url: '/guest-browser',
    payload: {},
  });
  assert.equal(unauthorized.statusCode, 401);
}
const browserRpc: GuestRequestPort = nodeAgent
  ? {
      call: async (_session, operation, abort) => {
        abort?.throwIfAborted();
        const request = envelope(operation);
        const response = await nodeAgent.inject({
          method: 'POST',
          url: '/guest-browser',
          headers: { authorization: `Bearer ${token}` },
          payload: { environment, request },
        });
        abort?.throwIfAborted();
        if (response.statusCode !== 200)
          throw new Error(`Node Agent rejected browser request (${response.statusCode})`);
        const result = guestResponseSchema.parse(response.json());
        assert.equal(result.requestId, request.requestId);
        assert.equal(result.generation, generation);
        return result.value;
      },
    }
  : desktopEnabled
    ? {
        call: async (_session, operation, abort) =>
          relay.callBrowser(environment, envelope(operation), abort ?? signal),
      }
    : rpc;
const browserRemote = new RemoteSandbox(browserRpc, sessionId);
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
  connection = new ZendriverMcpConnection(
    browserRemote.openBrowser(signal),
    desktopEnabled ? 100_000 : 30_000,
  );
  await connection.initialize(signal);
  const driver = new ZendriverBrowserDriver(connection, sessionId, generation, async () => true);
  await driver.open(signal, '155.0.8059.84', !desktopEnabled);
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
  const humanFrame = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const captured = await driver.humanFrame(true, context);
      if (captured.preview.state === 'busy') continue;
      assert.equal(captured.preview.state, 'frame');
      assert(captured.target);
      return { ...captured, target: { ...captured.target, frameId: randomUUID() } };
    }
    throw new Error('Guest private frame did not settle');
  };
  if (desktopEnabled) {
    const isolation = await remote.execArgv(
      '/usr/bin/python3',
      [
        '-c',
        `
import os,socket
for path in ('/run/trinity-browser','/var/lib/trinity/browser'):
  try: os.listdir(path)
  except PermissionError: pass
  else: raise SystemExit('browser files are accessible')
s=socket.socket()
s.settimeout(2)
if s.connect_ex(('127.0.0.1',39142)) == 0: raise SystemExit('debug endpoint is accessible')
`,
      ],
      { signal, maxOutputBytes: 1024 },
    );
    assert.equal(isolation.exitCode, 0, 'Workspace could access the isolated browser');
    const pageDebugAccess = await connection.call(
      'browser_evaluate',
      {
        expression:
          "fetch('http://127.0.0.1:39142/json/version',{mode:'no-cors'}).then(()=>true,()=>false)",
      },
      signal,
    );
    assert.deepEqual(
      pageDebugAccess.structuredContent,
      { value: false },
      'Chrome pages could reach the debugging endpoint',
    );
    await connection.call(
      'browser_evaluate',
      {
        expression: `(()=>{const b=document.createElement('button');b.id='desktop-pointer-fixture';b.style='position:fixed;left:0;top:0;width:200px;height:240px;z-index:99999';b.onclick=()=>document.body.dataset.desktopPointer='clicked';document.body.appendChild(b);return true})()`,
      },
      signal,
    );
    const pointerFrame = await browserRpc.call(sessionId, { kind: 'desktopFrame' }, signal);
    if (pointerFrame.kind !== 'desktopFrame') throw new Error('Desktop frame unavailable');
    const pointerResult = await browserRpc.call(
      sessionId,
      {
        kind: 'desktopInput',
        action: {
          type: 'click',
          point: { x: 40, y: 200 },
          button: 'left',
          count: 1,
          modifiers: [],
        },
        target: {
          width: pointerFrame.width,
          height: pointerFrame.height,
          ...(pointerFrame.focusRevision ? { focusRevision: pointerFrame.focusRevision } : {}),
        },
      },
      signal,
    );
    assert.deepEqual(pointerResult, { kind: 'desktopInput', effect: 'applied' });
    assert.deepEqual(
      (
        await connection.call(
          'browser_evaluate',
          { expression: 'document.body.dataset.desktopPointer' },
          signal,
        )
      ).structuredContent,
      { value: 'clicked' },
    );
    await connection.call(
      'browser_evaluate',
      { expression: "document.getElementById('desktop-pointer-fixture').remove()" },
      signal,
    );
    await connection.call(
      'browser_evaluate',
      {
        expression: `(()=>{const b=document.createElement('button');b.id='desktop-prompt-fixture';b.textContent='Prompt';b.style='position:fixed;left:0;top:0;width:200px;height:100px;z-index:99999';b.onclick=()=>document.body.dataset.desktopAnswer=prompt('Guest prompt','guest-default');document.body.appendChild(b);return true})()`,
      },
      signal,
    );
    const before = await browserRpc.call(sessionId, { kind: 'desktopFrame' }, signal);
    assert.equal(before.kind, 'desktopFrame');
    const trigger = driver.humanInput(
      { type: 'click', point: { x: 40, y: 40 }, button: 'left', count: 1, modifiers: [] },
      (await humanFrame()).target,
      context,
    );
    let resolved = false;
    void trigger.then(
      () => {
        resolved = true;
      },
      () => {
        resolved = true;
      },
    );
    const requireCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
    const png = requireCore('pngjs') as {
      PNG: { sync: { read: (bytes: Buffer) => { width: number; height: number; data: Buffer } } };
    };
    if (before.kind !== 'desktopFrame') throw new Error('Desktop frame unavailable');
    const beforePixels = png.PNG.sync.read(Buffer.from(before.png, 'base64'));
    let dialog: Extract<typeof before, { kind: 'desktopFrame' }> | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const frame = await browserRpc.call(sessionId, { kind: 'desktopFrame' }, signal);
      if (frame.kind !== 'desktopFrame') throw new Error('Desktop frame unavailable');
      const pixels = png.PNG.sync.read(Buffer.from(frame.png, 'base64'));
      let changed = 0;
      for (let i = 0; i < pixels.data.length; i += 4)
        if (Math.abs(pixels.data[i]! - beforePixels.data[i]!) > 40) changed++;
      if (changed > 10_000) {
        dialog = frame;
        break;
      }
    }
    assert(
      dialog && dialog.focusRevision && !resolved,
      'Dialog was not visible while the browser call was blocked',
    );
    for (const action of [
      { type: 'key', key: 'a', modifiers: ['ctrl'] },
      { type: 'text', text: 'A中🙂' },
    ] as const) {
      const frame = await browserRpc.call(sessionId, { kind: 'desktopFrame' }, signal);
      if (frame.kind !== 'desktopFrame' || !frame.focusRevision)
        throw new Error('Desktop focus unavailable');
      const input = await browserRpc.call(
        sessionId,
        {
          kind: 'desktopInput',
          action,
          target: { width: frame.width, height: frame.height, focusRevision: frame.focusRevision },
        },
        signal,
      );
      assert.deepEqual(input, { kind: 'desktopInput', effect: 'applied' });
    }
    dialog = await browserRpc.call(sessionId, { kind: 'desktopFrame' }, signal).then((frame) => {
      if (frame.kind !== 'desktopFrame' || !frame.focusRevision)
        throw new Error('Desktop focus unavailable');
      return frame;
    });
    const accepted = await browserRpc.call(
      sessionId,
      {
        kind: 'desktopInput',
        action: { type: 'key', key: 'Enter', modifiers: [] },
        target: { width: dialog.width, height: dialog.height, focusRevision: dialog.focusRevision },
      },
      signal,
    );
    assert.deepEqual(accepted, { kind: 'desktopInput', effect: 'applied' });
    assert.equal((await trigger)?.effect, 'applied');
    assert.deepEqual(
      (
        await connection.call(
          'browser_evaluate',
          { expression: 'document.body.dataset.desktopAnswer' },
          signal,
        )
      ).structuredContent,
      { value: 'A中🙂' },
    );
    await connection.call(
      'browser_evaluate',
      { expression: "document.getElementById('desktop-prompt-fixture').remove()" },
      signal,
    );
    if (process.env['TRINITY_GUEST_PG_TEST'] === '1') {
      const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
      requireDb('dotenv/config');
      const url = process.env['DATABASE_URL'];
      if (!url) throw new Error('DATABASE_URL is required for PostgreSQL handoff acceptance');
      const pg = requireDb('pg') as typeof import('pg');
      const schema = `desktop_handoff_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Pool({ connectionString: url });
      const pool = new pg.Pool({
        connectionString: url,
        options: `-c search_path=${schema},public`,
      });
      let created = false;
      try {
        await admin.query(`create schema ${schema}`);
        created = true;
        for (const table of [
          'browser_runtimes',
          'browser_commands',
          'browser_controls',
          'browser_user_inputs',
        ])
          await admin.query(`create table ${schema}.${table} (like public.${table} including all)`);
        await checkGuestDesktopHandoff(connection, browserRpc, sessionId, signal, {
          journal: new PgBrowserRuntimeStore(pool),
          controls: new PgBrowserInteractionStore(pool),
        });
      } finally {
        await pool.end();
        if (created) await admin.query(`drop schema ${schema} cascade`);
        await admin.end();
      }
      console.log(`Guest ${phase}: blocked dialog handoff passed with PostgreSQL fencing.`);
    } else {
      await checkGuestDesktopHandoff(connection, browserRpc, sessionId, signal);
    }
    for (const [expression, key, expected] of [
      ["alert('Guest alert');document.body.dataset.dialogResult='alerted'", 'Enter', 'alerted'],
      ["document.body.dataset.dialogResult=String(confirm('Guest confirm'))", 'Enter', 'true'],
      ["document.body.dataset.dialogResult=String(confirm('Guest confirm'))", 'Escape', 'false'],
      ["document.body.dataset.dialogResult=String(prompt('Guest prompt'))", 'Escape', 'null'],
    ] as const) {
      await connection.call(
        'browser_evaluate',
        {
          expression: `(()=>{const b=document.createElement('button');b.id='desktop-dialog-fixture';b.style='position:fixed;left:0;top:0;width:200px;height:100px;z-index:99999';b.onclick=()=>{${expression}};document.body.appendChild(b);return true})()`,
        },
        signal,
      );
      const initial = await browserRpc.call(sessionId, { kind: 'desktopFrame' }, signal);
      if (initial.kind !== 'desktopFrame') throw new Error('Desktop frame unavailable');
      const initialPixels = png.PNG.sync.read(Buffer.from(initial.png, 'base64'));
      const pending = driver.humanInput(
        { type: 'click', point: { x: 40, y: 40 }, button: 'left', count: 1, modifiers: [] },
        (await humanFrame()).target,
        context,
      );
      let frame: Extract<typeof initial, { kind: 'desktopFrame' }> | undefined;
      for (let attempt = 0; attempt < 12; attempt++) {
        const captured = await browserRpc.call(sessionId, { kind: 'desktopFrame' }, signal);
        if (captured.kind !== 'desktopFrame') throw new Error('Desktop frame unavailable');
        const pixels = png.PNG.sync.read(Buffer.from(captured.png, 'base64'));
        let changed = 0;
        for (let i = 0; i < pixels.data.length; i += 4)
          if (Math.abs(pixels.data[i]! - initialPixels.data[i]!) > 40) changed++;
        if (changed > 10_000 && captured.focusRevision) {
          frame = captured;
          break;
        }
      }
      if (!frame?.focusRevision) throw new Error('Desktop dialog was not visible');
      const dismissal = await browserRpc.call(
        sessionId,
        {
          kind: 'desktopInput',
          action: { type: 'key', key, modifiers: [] },
          target: { width: frame.width, height: frame.height, focusRevision: frame.focusRevision },
        },
        signal,
      );
      assert.deepEqual(dismissal, { kind: 'desktopInput', effect: 'applied' });
      assert.equal((await pending)?.effect, 'applied');
      assert.deepEqual(
        (
          await connection.call(
            'browser_evaluate',
            { expression: 'document.body.dataset.dialogResult' },
            signal,
          )
        ).structuredContent,
        { value: expected },
      );
      await connection.call(
        'browser_evaluate',
        { expression: "document.getElementById('desktop-dialog-fixture').remove()" },
        signal,
      );
    }
    console.log(
      `Guest ${phase}: isolated desktop displayed and dismissed a blocked Chrome prompt.`,
    );
  }
  await driver.humanInput(
    { type: 'open_browser_page', page: 'bookmarks' },
    (await humanFrame()).target,
    context,
  );
  const bookmarks = await humanFrame();
  // Exercise real Chrome bookmark UI in this disposable guest profile. A DOM
  // menu being open is insufficient: the pixels must also contain the popup.
  const fixtureUrl = `${url}?bookmark-fixture=${phase}`;
  const evaluate = async (expression: string): Promise<unknown> =>
    (await connection!.call('browser_evaluate_main', { expression }, signal)).structuredContent;
  if (desktopEnabled) {
    const title = 'Guest profile persistence marker';
    if (phase === 'write') {
      await evaluate(
        `new Promise(resolve=>chrome.bookmarks.create({parentId:'1',title:${JSON.stringify(title)},url:'https://example.com/trinity-profile-persistence'},resolve))`,
      );
    } else {
      const saved = (await evaluate(
        `new Promise(resolve=>chrome.bookmarks.search({title:${JSON.stringify(title)}},resolve))`,
      )) as { value: { id: string; url?: string }[] };
      assert.equal(saved.value.length, 1, 'Bookmark did not persist across guest generations');
      assert.equal(saved.value[0]?.url, 'https://example.com/trinity-profile-persistence');
      await evaluate(
        `new Promise(resolve=>chrome.bookmarks.remove(${JSON.stringify(saved.value[0]!.id)},resolve))`,
      );
      console.log('Guest read: Chrome bookmark persisted across the guest generation.');
    }
  }
  const created = (await evaluate(
    `new Promise(resolve=>chrome.bookmarks.create({parentId:'1',title:'Guest fixture bookmark',url:${JSON.stringify(fixtureUrl)}},resolve))`,
  )) as { value: { id: string } };
  type Rect = { x: number; y: number; width: number; height: number };
  const positionsExpression = `(()=>{let item;function scan(n){for(const e of n.querySelectorAll('*')){if(e.tagName==='BOOKMARKS-ITEM'&&e.getAttribute('aria-label')==='Guest fixture bookmark')item=e;if(e.shadowRoot)scan(e.shadowRoot)}}scan(document);if(!item)return null;const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {item:rect(item),button:rect(item.shadowRoot.querySelector('#menuButton'))}})()`;
  let positions: { item: Rect; button: Rect } | null = null;
  for (let attempt = 0; attempt < 8 && !positions; attempt++)
    positions = ((await evaluate(positionsExpression)) as { value: typeof positions }).value;
  assert(positions, 'Guest bookmark item not rendered');
  const beforeMenu = await humanFrame();
  assert.equal(beforeMenu.preview.state, 'frame');
  const point = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  await driver.humanInput(
    { type: 'click', point: point(positions.button), button: 'left', count: 1, modifiers: [] },
    beforeMenu.target,
    context,
  );
  const menu = (await evaluate(
    `(()=>{let menu;function scan(n){for(const e of n.querySelectorAll('*')){if(e.tagName==='CR-ACTION-MENU'&&e.open)menu=e;if(e.shadowRoot)scan(e.shadowRoot)}}scan(document);if(!menu)return null;const r=menu.shadowRoot.querySelector('dialog').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
  )) as { value: Rect | null };
  assert(menu.value, 'Guest bookmark menu did not open');
  const afterMenu = await humanFrame();
  assert.equal(afterMenu.preview.state, 'frame');
  const requireCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
  const png = requireCore('pngjs') as {
    PNG: { sync: { read: (bytes: Buffer) => { width: number; height: number; data: Buffer } } };
  };
  const beforePixels = png.PNG.sync.read(Buffer.from(beforeMenu.preview.png, 'base64'));
  const afterPixels = png.PNG.sync.read(Buffer.from(afterMenu.preview.png, 'base64'));
  let changed = 0;
  for (
    let y = Math.ceil(menu.value.y + 45);
    y < Math.min(afterPixels.height, menu.value.y + menu.value.height);
    y++
  ) {
    for (
      let x = Math.ceil(menu.value.x);
      x < Math.min(afterPixels.width, menu.value.x + menu.value.width);
      x++
    ) {
      const i = (y * afterPixels.width + x) * 4;
      if (
        Math.abs(afterPixels.data[i]! - beforePixels.data[i]!) +
          Math.abs(afterPixels.data[i + 1]! - beforePixels.data[i + 1]!) +
          Math.abs(afterPixels.data[i + 2]! - beforePixels.data[i + 2]!) >
        40
      )
        changed++;
    }
  }
  assert(changed > 300, 'Guest bookmark menu is missing from captured pixels');
  await driver.humanInput(
    { type: 'click', point: { x: 400, y: 400 }, button: 'left', count: 1, modifiers: [] },
    afterMenu.target,
    context,
  );
  const row = { x: positions.item.x + 80, y: positions.item.y + positions.item.height / 2 };
  await driver.humanInput(
    { type: 'click', point: row, button: 'left', count: 1, modifiers: [] },
    (await humanFrame()).target,
    context,
  );
  await driver.humanInput(
    { type: 'click', point: row, button: 'left', count: 2, modifiers: [] },
    (await humanFrame()).target,
    context,
  );
  let clickedTab: string | undefined;
  for (let attempt = 0; attempt < 8 && !clickedTab; attempt++)
    clickedTab = (await humanFrame()).browser?.tabs.find((tab) => tab.url === fixtureUrl)?.id;
  assert(clickedTab, 'Guest double click did not open bookmark');
  await driver.humanInput(
    { type: 'close_tab', tabId: clickedTab },
    (await humanFrame()).target,
    context,
  );
  await evaluate(
    `new Promise(resolve=>chrome.bookmarks.remove(${JSON.stringify(created.value.id)},resolve))`,
  );
  await connection.call(
    'browser_evaluate_main',
    {
      expression: `new Promise(resolve=>chrome.tabs.create({url:${JSON.stringify(url)},active:false},()=>resolve(true)))`,
    },
    signal,
  );
  let opened: string | undefined;
  for (let attempt = 0; attempt < 8 && !opened; attempt++)
    opened = (await humanFrame()).browser?.tabs.find((tab) => !tab.active && tab.url === url)?.id;
  assert(opened, 'Chrome-created background tab was not registered');
  assert.deepEqual(
    await driver.humanInput(
      { type: 'switch_tab', tabId: opened },
      (await humanFrame()).target,
      context,
    ),
    { effect: 'applied' },
  );
  assert.equal((await humanFrame()).target.tabId, opened);
  await driver.humanInput({ type: 'new_tab' }, { recovery: 'new_tab' }, context);
  const recovery = await humanFrame();
  assert.notEqual(recovery.target.tabId, opened);
  await driver.humanInput(
    { type: 'close_tab', tabId: recovery.target.tabId },
    recovery.target,
    context,
  );
  await driver.humanInput(
    { type: 'switch_tab', tabId: bookmarks.target.tabId },
    (await humanFrame()).target,
    context,
  );
  assert.equal((await humanFrame()).target.tabId, bookmarks.target.tabId);
  await driver.humanInput(
    { type: 'close_tab', tabId: opened },
    (await humanFrame()).target,
    context,
  );
  console.log(
    `Guest ${phase}: native bookmark tab capture, switching and explicit recovery passed.`,
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
await nodeAgent?.close();
