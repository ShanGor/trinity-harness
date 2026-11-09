/**
 * Runs only through the configured guest Sandbox argv port. Static source and a
 * separate path argument keep filenames out of code/shell syntax. Node is part
 * of every guest runtime; no extra utility or new RPC version is needed.
 */
export const workspaceViewerScript = String.raw`
import { lstat, opendir, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';

import path from 'node:path';
try {
  const relative = process.argv[1] ?? '';
  const segments = relative === '' ? [] : relative.split('/');
  if (relative.length > 1000 || relative.includes('\\') || relative.includes('\0') ||
      segments.some((part) => !part || part === '.' || part === '..' || part === 'model-context'))
    throw new Error('Invalid path');
  const root = await realpath(process.cwd());
  let target = root;
  for (const segment of segments) {
    target = path.join(target, segment);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink unavailable');
  }
  const canonical = await realpath(target);
  if (canonical !== root && !canonical.startsWith(root + path.sep)) throw new Error('Outside workspace');
  if (process.argv[2] === 'file') {
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Not a regular file');
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      let content = new TextDecoder().decode(buffer.subarray(0, Math.min(bytesRead, 65536)), { stream: bytesRead > 65536 });
      let truncated = bytesRead > 65536 || info.size > bytesRead;
      let offset = 0;
      for (let line = 0; line < 2000; line++) {
        const newline = content.indexOf('\n', offset);
        if (newline < 0) break;
        offset = newline + 1;
        if (line === 1999 && offset < content.length) {
          content = content.slice(0, offset);
          truncated = true;
        }
      }
      process.stdout.write(JSON.stringify({ content, truncated, offset: 1 }));
    } finally { await handle.close(); }
  } else {
  const entries = [];
  let truncated = false;
  for await (const entry of await opendir(canonical)) {
    if (entry.name === 'model-context') continue;
    if (entries.length === 500) { truncated = true; break; }
    entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  process.stdout.write(JSON.stringify({ entries, truncated }));
  }
} catch {
  process.stderr.write('Workspace entry unavailable');
  process.exitCode = 1;
}
`;
