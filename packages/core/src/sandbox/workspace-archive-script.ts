import { workspaceFileAccessScript } from './workspace-document-script.js';

/** A bounded read-only archive, transported through the existing guest argv protocol. */
export const workspaceArchiveScript = String.raw`
${workspaceFileAccessScript}
import { opendir } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';
// ZIP32 with UTF-8 names and deflated regular files. No temporary archive or guest utility.
async function archive(parent) {
  const limit = 5 * 1024 * 1024;
  const local = [], central = [];
  let size = 0, inputBytes = 0, count = 0, visited = 0, centralSize = 0;
  function add(name, data, isDirectory) {
    const filename = Buffer.from(name);
    if (filename.length > 65535) throw Error('Archive path too long');
    const compressed = isDirectory ? Buffer.alloc(0) : deflateRawSync(data);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(isDirectory ? 0 : 8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01, with no source timestamp promised.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6);
    header.copy(index, 8, 6, 28);
    index.writeUInt32LE(isDirectory ? 0x10 : 0, 38);
    index.writeUInt32LE(size, 42);
    local.push(header, filename, compressed); central.push(index, filename);
    size += header.length + filename.length + compressed.length;
    centralSize += index.length + filename.length;
    count++;
    if (size + centralSize + 22 > limit) throw Error('ZIP limit is 5 MiB');
  }
  async function walk(folder, prefix, depth) {
    if (depth > 32) throw Error('Archive depth limit is 32');
    const entries = await opendir(at(folder));
    for await (const entry of entries) {
      if (++visited > 1000) throw Error('Archive entry limit is 1000');
      if (entry.name === 'model-context') continue;
      // Backslashes are separators on some ZIP extractors; never emit ambiguous paths.
      if (entry.name.includes('\\')) throw Error('Unsupported archive filename');
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        const child = await open(at(folder) + '/' + entry.name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
        try { add(name + '/', Buffer.alloc(0), true); await walk(child, name + '/', depth + 1); }
        finally { await child.close(); }
      } else if (entry.isFile()) {
        const data = await bytes(folder, entry.name, limit - inputBytes);
        inputBytes += data.length;
        add(name, data, false);
      }
    }
  }
  await walk(parent, '', 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(size, 16);
  return Buffer.concat([...local, ...central, end]);
}

try {
  const req = JSON.parse(process.argv.slice(1).join(''));
  const parts = req.path === '' ? [] : req.path.split('/');
  if (req.path.length > 1000 || req.path.includes('\\') || req.path.includes('\0') ||
      parts.some(p => !p || p === '.' || p === '..' || p === 'model-context')) throw Error('Invalid path');
  let parent = await open('.', C.O_RDONLY | C.O_DIRECTORY); handles.push(parent);
  for (const part of parts) parent = await directory(parent, part);
  process.stdout.write(JSON.stringify({base64: (await archive(parent)).toString('base64')}));
} catch (e) {
  process.stderr.write(String(e.message));
  process.exitCode = 1;
} finally {
  for (const h of handles.reverse()) await h.close();
}
`;
