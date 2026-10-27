import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function fixture() {
  directory = await mkdtemp(path.join(tmpdir(), 'trinity-profile-migration-'));
  const profile = path.join(directory, 'profile'),
    external = path.join(directory, 'external');
  await mkdir(profile);
  await mkdir(external);
  await writeFile(path.join(external, 'outside'), 'untouched');
  await writeFile(path.join(profile, 'inside'), 'profile');
  await symlink(external, path.join(profile, 'link'));
  const recorder = path.join(directory, 'chown');
  const log = path.join(directory, 'changed');
  await writeFile(recorder, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$PROFILE_TEST_LOG"\n');
  await chmod(recorder, 0o700);
  const source = fileURLToPath(
    new URL('../../../deploy/firecracker/guest/browser-profile-owner.sh', import.meta.url),
  );
  const script = (await readFile(source, 'utf8'))
    .replace('profile=/var/lib/trinity/browser', `profile=${JSON.stringify(profile)}`)
    .replace('/usr/bin/mountpoint -q', '/usr/bin/true')
    .replace('/usr/bin/chown', recorder);
  const testScript = path.join(directory, 'migrate.sh');
  await writeFile(testScript, script);
  const run = () =>
    execFileSync('bash', [testScript], { env: { ...process.env, PROFILE_TEST_LOG: log } });
  return { profile, external, log, run };
}
it('migrates only profile entries and does not follow a symlink out of the profile', async () => {
  const f = await fixture();
  f.run();
  const changed = await readFile(f.log, 'utf8');
  expect(changed).toContain(path.join(f.profile, 'inside'));
  expect(changed).toContain(path.join(f.profile, 'link'));
  expect(changed).not.toContain(path.join(f.external, 'outside'));
});
it('refuses a hard-linked profile file before changing ownership', async () => {
  const f = await fixture();
  await link(path.join(f.external, 'outside'), path.join(f.profile, 'hardlink'));
  expect(f.run).toThrow();
  await expect(readFile(f.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
