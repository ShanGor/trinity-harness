import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const wrapper = fileURLToPath(
  new URL('../../../deploy/firecracker/guest/chrome-private-debug.sh', import.meta.url),
);
function run(...args: string[]) {
  return spawnSync(
    'bash',
    ['-c', 'exec() { printf "<%s>\\n" "$@"; }; source "$1" "${@:2}"', 'fixture', wrapper, ...args],
    { encoding: 'utf8' },
  );
}
it('pins Chrome debugging to the firewalled port and preserves the other arguments', () => {
  const result = run(
    '--remote-debugging-port=0',
    '--user-data-dir=/private/profile',
    'https://example.test/',
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    '</usr/bin/setpriv>\n<--reuid=1002>\n<--regid=1002>\n<--clear-groups>\n<--inh-caps=-all>\n<--ambient-caps=-all>\n<--bounding-set=-all>\n<--no-new-privs>\n</opt/google/chrome/google-chrome>\n<--remote-debugging-port=39142>\n<--user-data-dir=/private/profile>\n<https://example.test/>\n<--start-maximized>\n',
  );
});
it.each([
  [],
  ['--remote-debugging-port=9222'],
  ['--remote-debugging-port=0', '--remote-debugging-port=0'],
  ['--remote-debugging-port=0', '--remote-debugging-address=0.0.0.0'],
  ['--remote-debugging-port=0', '--remote-debugging-pipe'],
])('rejects unsafe debugging flags %j', (...args) => {
  const result = run(...args);
  expect(result.status).toBe(64);
  expect(result.stdout).toBe('');
});
