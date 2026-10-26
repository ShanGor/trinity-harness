import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gateway(
  settings: {
    docker?: boolean;
    owned?: boolean;
    linked?: boolean;
    failInsert?: boolean;
    failInspect?: boolean;
    empty?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trinity-forwarding-'));
  directories.push(directory);
  const calls = path.join(directory, 'calls');
  const rules = path.join(directory, 'rules');
  const batch = path.join(directory, 'batch');
  const initial = settings.empty
    ? []
    : [
        ['-s', '192.0.2.0/24', '-j', 'DROP'],
        ['-j', 'RETURN'],
      ];
  await writeFile(rules, JSON.stringify(initial));
  const commands: Record<string, string> = {
    id: '#!/bin/sh\necho 0\n',
    ip: `#!/bin/sh
case "$*" in
  '-d -o link show dev trinity-egress0') echo 'bridge alias trinity-firecracker-egress' ;;
  '-o -4 address show dev trinity-egress0') echo 'inet 172.29.240.1/20 scope global' ;;
esac
exit 0
`,
    sysctl: '#!/bin/sh\nexit 0\n',
    nft: `#!/bin/sh
if [ "$1" = -f ]; then
  cat > "$FORWARD_BATCH"
elif [ "$FORWARD_OWNED" = true ]; then
  echo 'comment "managed-by-Trinity-Firecracker-egress-v1"'
else
  echo 'comment "another-owner"'
fi
`,
    iptables: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FORWARD_CALLS, JSON.stringify(args) + '\\n');
if (args.splice(0, 2).join(' ') !== '-w 5') throw Error('Missing xtables lock wait');
const rules = JSON.parse(fs.readFileSync(process.env.FORWARD_RULES, 'utf8'));
if (args.join(' ') === '-S DOCKER-USER') {
  if (process.env.FORWARD_INSPECT_FAIL === 'true') process.exit(4);
  if (process.env.FORWARD_DOCKER !== 'true') process.exit(1);
  console.log('-N DOCKER-USER');
  rules.forEach(rule => console.log('-A DOCKER-USER ' + rule.join(' ')));
} else if (args.join(' ') === '-C FORWARD -j DOCKER-USER') {
  process.exit(process.env.FORWARD_LINKED === 'true' ? 0 : 1);
} else if (args[0] === '-C' && args[1] === 'DOCKER-USER') {
  const rule = args.slice(2);
  process.exit(rules.some(value => JSON.stringify(value) === JSON.stringify(rule)) ? 0 : 1);
} else if (args[0] === '-I' && args[1] === 'DOCKER-USER') {
  if (process.env.FORWARD_INSERT_FAIL === 'true') process.exit(4);
  rules.splice(Number(args[2]) - 1, 0, args.slice(3));
  fs.writeFileSync(process.env.FORWARD_RULES, JSON.stringify(rules));
} else {
  throw Error('Unexpected firewall mutation: ' + args.join(' '));
}
`,
  };
  await Promise.all(
    Object.entries(commands).map(([name, content]) =>
      writeFile(path.join(directory, name), content, { mode: 0o755 }),
    ),
  );
  const source = path.join(directory, 'gateway');
  await writeFile(
    source,
    (
      await readFile(path.resolve('deploy/firecracker/trinity-firecracker-egress-up'), 'utf8')
    ).replaceAll('/etc/trinity/sandbox-egress/proxy.json', path.join(directory, 'proxy.json')),
  );
  const run = (action = 'docker-forwarding') =>
    exec('bash', [source, action], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env['PATH'] ?? ''}`,
        FORWARD_CALLS: calls,
        FORWARD_RULES: rules,
        FORWARD_BATCH: batch,
        FORWARD_DOCKER: String(settings.docker ?? true),
        FORWARD_OWNED: String(settings.owned ?? true),
        FORWARD_LINKED: String(settings.linked ?? true),
        FORWARD_INSERT_FAIL: String(settings.failInsert ?? false),
        FORWARD_INSPECT_FAIL: String(settings.failInspect ?? false),
      },
    });
  return {
    run,
    initial,
    rules: async (): Promise<string[][]> =>
      z.array(z.array(z.string())).parse(JSON.parse(await readFile(rules, 'utf8'))),
    calls: async (): Promise<string[][]> =>
      (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => z.array(z.string()).parse(JSON.parse(line))),
    batch: (): Promise<string> => readFile(batch, 'utf8'),
  };
}

it('adds scoped guest and reply rules before RETURN while preserving earlier operator policy', async () => {
  const fixture = await gateway();
  await fixture.run();
  const rules = await fixture.rules();
  expect(rules[0]).toEqual(fixture.initial[0]);
  expect(rules.at(-1)).toEqual(fixture.initial[1]);
  expect(rules.slice(1, -1)).toEqual(
    expect.arrayContaining([
      [
        '-i',
        'trinity-egress0',
        '-s',
        '172.29.240.0/20',
        '!',
        '-o',
        'trinity-egress0',
        '-m',
        'comment',
        '--comment',
        'trinity-firecracker-egress-v1',
        '-j',
        'ACCEPT',
      ],
      [
        '!',
        '-i',
        'trinity-egress0',
        '-o',
        'trinity-egress0',
        '-d',
        '172.29.240.0/20',
        '-m',
        'conntrack',
        '--ctstate',
        'ESTABLISHED,RELATED',
        '-m',
        'comment',
        '--comment',
        'trinity-firecracker-egress-v1',
        '-j',
        'ACCEPT',
      ],
    ]),
  );
  await fixture.run();
  expect(await fixture.rules()).toEqual(rules);
  const inserts = (await fixture.calls()).filter((args) => args.includes('-I'));
  expect(inserts).toHaveLength(2);
  await expect(fixture.batch()).rejects.toMatchObject({ code: 'ENOENT' });
});

it('repairs an empty DOCKER-USER without changing the global FORWARD DROP policy', async () => {
  const fixture = await gateway({ empty: true });
  await fixture.run();
  const rules = await fixture.rules();
  expect(rules).toHaveLength(2);
  expect(rules.every((rule) => rule.at(-1) === 'ACCEPT')).toBe(true);
  expect((await fixture.calls()).every((args) => !args.includes('-P'))).toBe(true);
});

it('keeps native nftables setup and its security drops on hosts without DOCKER-USER', async () => {
  const fixture = await gateway({ docker: false });
  await expect(fixture.run('up')).resolves.toMatchObject({
    stdout: expect.stringContaining('Firecracker host NAT bridge is ready'),
  });
  expect(await fixture.rules()).toEqual(fixture.initial);
  const batch = await fixture.batch();
  expect(batch).toContain('iifname "trinity-egress0" meta nfproto ipv6 drop');
  expect(batch).toContain('10.0.0.0/8');
  expect(batch).toContain('oifname "trinity-egress0" drop');
  expect(batch).toContain('masquerade');
});

it('also configures Docker forwarding during normal gateway startup', async () => {
  const fixture = await gateway();
  await fixture.run('up');
  expect(await fixture.rules()).toHaveLength(4);
  expect(await fixture.batch()).toContain('managed-by-Trinity-Firecracker-egress-v1');
});

it.each([{ failInsert: true }, { failInspect: true }, { linked: false }, { owned: false }])(
  'fails closed when the host firewall cannot be safely configured (%j)',
  async (settings) => {
    const fixture = await gateway(settings);
    await expect(fixture.run()).rejects.toThrow();
    expect(await fixture.rules()).toEqual(fixture.initial);
  },
);
