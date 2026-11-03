import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { deployedRuntimeConfig } from './podman-runtime.mjs';

const names = [
  'trinity-browser-runtime',
  'trinity-server',
  'trinity-agent-worker',
  'trinity-audit-consumer',
  'trinity-gateway',
];
const env = {
  PORT: '3100',
  EXECUTION_DRIVER: 'firecracker',
  BROWSER_DRIVER: 'zendriver',
  BROWSER_RUNTIME_ENDPOINT: 'http://127.0.0.1:3010',
  BROWSER_RUNTIME_TOKEN: 'b'.repeat(32),
  NODE_RUNTIME_TOKEN: 'n'.repeat(32),
  FIRECRACKER_NODES: JSON.stringify([{ id: 'local', endpoint: 'http://127.0.0.1:3030' }]),
  TOKEN_SECRET: 'private=value',
};
const containers = [
  {
    Name: 'trinity-server',
    Config: { Env: Object.entries(env).map(([key, value]) => `${key}=${value}`) },
  },
  { Name: 'trinity-gateway', Config: { Labels: { 'io.trinity.web-port': '8181' } } },
];

test('saved configuration preserves credentials containing equals and discovers deployed ports', () => {
  const config = deployedRuntimeConfig(containers);
  assert.equal(config.webPort, 8181);
  assert.equal(config.nodeToken, env.NODE_RUNTIME_TOKEN);
  assert.equal(config.browserEndpoint, env.BROWSER_RUNTIME_ENDPOINT);
  assert.equal(deployedRuntimeConfig(containers, '8282').webPort, 8282);
  assert.equal(
    deployedRuntimeConfig([containers[0], { Name: '/trinity-gateway', Config: {} }]).webPort,
    8080,
  );
  for (const port of ['3100', '80', '65536', 'invalid'])
    assert.throws(() => deployedRuntimeConfig(containers, port));
});

function run(action, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trinity-services-test-'));
  try {
    writeFileSync(path.join(dir, 'containers.json'), JSON.stringify(containers));
    const mock = `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (tool === 'node' && args[0] !== 'scripts/podman-runtime.mjs') {
  const result = spawnSync(${JSON.stringify(process.execPath)}, args, {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'podman') {
  if (args[0] === 'container') process.exit(args[2] === process.env.MOCK_MISSING ? 1 : 0);
  if (args[0] === 'inspect') {
    if (args[1] !== '--format') process.stdout.write(fs.readFileSync(process.env.MOCK_CONTAINERS));
    else console.log(args[2].includes('Running') ? 'true' : (process.env.MOCK_STATUS || 'running'));
  } else if (!['start', 'stop'].includes(args[0])) process.exit(90);
}
if (tool === 'systemctl' && args[0] === 'is-active' && process.env.MOCK_INACTIVE) process.exit(1);
if (tool === 'node' && args.at(-1) === process.env.MOCK_PROBE_FAIL) process.exit(1);
`;
    for (const tool of ['podman', 'node', 'curl', 'systemctl', 'pkexec']) {
      writeFileSync(path.join(dir, tool), mock, { mode: 0o755 });
    }
    const result = spawnSync('bash', ['scripts/podman-services.sh', ...action], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        WEB_PORT: '',
        MOCK_LOG: `${dir}/log`,
        MOCK_CONTAINERS: `${dir}/containers.json`,
        ...overrides,
      },
    });
    const log = readFileSync(path.join(dir, 'log'), { encoding: 'utf8', flag: 'a+' }).trim();
    return { ...result, calls: log ? log.split('\n').map((line) => JSON.parse(line)) : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const effects = (result, operation) =>
  result.calls.filter((call) => call[0] === 'podman' && call[1] === operation);

test('start reuses all containers in dependency order without builds, migrations or secrets in output', () => {
  const result = run(['start']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    effects(result, 'start').map((call) => call[2]),
    names,
  );
  assert.equal(effects(result, 'stop').length, 0);
  assert.equal(
    result.calls.some((call) => call[0] === 'pkexec'),
    false,
  );
  assert.match(result.stdout, /8181/);
  assert.ok(!JSON.stringify(result.calls).includes(env.NODE_RUNTIME_TOKEN));
  const browserProbe = result.calls.findIndex(
    (call) => call[0] === 'node' && call.at(-1) === 'browser',
  );
  const workerStart = result.calls.findIndex(
    (call) => call[1] === 'start' && call[2] === 'trinity-agent-worker',
  );
  assert.ok(browserProbe < workerStart);
});

test('stop tolerates missing containers and leaves host services alone', () => {
  const result = run(['stop'], { MOCK_MISSING: 'trinity-server' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    effects(result, 'stop').map((call) => call.at(-1)),
    [...names].reverse().filter((name) => name !== 'trinity-server'),
  );
  assert.ok(result.calls.every((call) => call[0] === 'podman'));
});

test('restart stops in reverse order then starts in dependency order', () => {
  const result = run(['restart']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    effects(result, 'stop').map((call) => call.at(-1)),
    [...names].reverse(),
  );
  assert.deepEqual(
    effects(result, 'start').map((call) => call[2]),
    names,
  );
});

test('missing deployment fails before restart can stop anything', () => {
  const result = run(['restart'], { MOCK_MISSING: 'trinity-gateway' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deploy-podman.sh/);
  assert.equal(effects(result, 'stop').length, 0);
  assert.equal(effects(result, 'start').length, 0);
});

test('failed runtime authentication prevents dependent consumers from starting', () => {
  for (const kind of ['node', 'browser']) {
    const result = run(['start'], { MOCK_PROBE_FAIL: kind });
    assert.equal(result.status, 1);
    assert.deepEqual(
      effects(result, 'start').map((call) => call[2]),
      kind === 'node' ? [] : ['trinity-browser-runtime'],
    );
  }
});

test('starts an inactive installed Node Agent through the existing polkit path', () => {
  const result = run(['start'], { MOCK_INACTIVE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.find((call) => call[0] === 'pkexec'),
    ['pkexec', '/usr/bin/systemctl', 'start', 'trinity-node-agent.service'],
  );
});

test('status reports running, stopped and missing containers without effects', () => {
  for (const overrides of [{}, { MOCK_STATUS: 'exited' }, { MOCK_MISSING: 'trinity-server' }]) {
    const result = run(['status'], overrides);
    assert.equal(result.status, Object.keys(overrides).length ? 1 : 0);
    assert.equal(effects(result, 'start').length + effects(result, 'stop').length, 0);
    for (const name of names) assert.ok(result.stdout.includes(name));
  }
});

test('help and invalid arguments do not invoke services', () => {
  for (const action of [['--help'], [], ['unknown'], ['stop', 'extra']]) {
    const result = run(action);
    assert.equal(result.status, action[0] === '--help' ? 0 : 2);
    assert.equal(result.calls.length, 0);
  }
});
