/** Fixed Linux guest program. Directory descriptors fence symlink and ancestor swaps. */
export const workspaceDocumentScript = String.raw`
import { open, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { constants as C } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const handles = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const at = h => '/proc/self/fd/' + h.fd;
async function directory(parent, name, create = false) {
  const target = at(parent) + '/' + name;
  if (create) { try { await mkdir(target, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  const h = await open(target, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  handles.push(h); return h;
}
async function bytes(parent, name, max) {
  const h = await open(at(parent) + '/' + name, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const info = await h.stat();
    if (!info.isFile() || info.size > max) throw Error('File unavailable or too large');
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const read = await h.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > max) throw Error('File too large');
    return buffer.subarray(0, size);
  } finally { await h.close(); }
}
let lock;
let lockPath;
try {
  const req = JSON.parse(process.argv.slice(1).join(''));
  const parts = req.path.split('/');
  if (!req.path || req.path.length > 1000 || req.path.includes('\\') || req.path.includes('\0') ||
      parts.some(p => !p || p === '.' || p === '..' || p === 'model-context')) throw Error('Invalid path');
  const root = await open('.', C.O_RDONLY | C.O_DIRECTORY); handles.push(root);
  let parent = root;
  for (const part of parts.slice(0,-1)) parent = await directory(parent, part);
  const name = parts.at(-1);
  if (req.operation === 'read' && !req.revision) {
    const data = await bytes(parent, name, 5 * 1024 * 1024);
    let text;
    if (!data.includes(0)) {
      try { text = new TextDecoder('utf-8', {fatal:true}).decode(data); } catch { text = undefined; }
    }
    process.stdout.write(JSON.stringify({version: hash(data), base64: data.toString('base64'), isText: text !== undefined}));
  } else {
    const privateDir = await directory(root, 'model-context', true);
    const revisions = await directory(privateDir, 'workspace-revisions', true);
    const store = await directory(revisions, hash(req.path), true);
    if (req.operation === 'history') {
      const names = (await readdir(at(store))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
      if (names.length > 100) throw Error('Revision limit reached');
      const result = [];
      for (const n of names) {
        const record = JSON.parse((await bytes(store, n, 32 * 1024 * 1024)).toString());
        result.push({version: record.version, capturedAt: record.capturedAt});
      }
      result.sort((a,b) => b.capturedAt.localeCompare(a.capturedAt));
      process.stdout.write(JSON.stringify({revisions: result}));
    } else if (req.operation === 'read') {
      if (!/^[a-f0-9]{64}$/.test(req.revision)) throw Error('Invalid revision');
      const record = JSON.parse((await bytes(store, req.revision + '.json', 32 * 1024 * 1024)).toString());
      if (hash(Buffer.from(record.text)) !== req.revision || record.version !== req.revision) throw Error('Invalid revision');
      process.stdout.write(JSON.stringify({version: record.version, base64: Buffer.from(record.text).toString('base64'), isText:true}));
    } else if (req.operation === 'save') {
      lockPath = at(store) + '/save.lock';
      lock = await open(lockPath, 'wx', 0o600);
      const old = await bytes(parent, name, 5 * 1024 * 1024);
      const modeHandle = await open(at(parent) + '/' + name, C.O_RDONLY | C.O_NOFOLLOW);
      const mode = (await modeHandle.stat()).mode & 0o777; await modeHandle.close();
      if (hash(old) !== req.expectedVersion) throw Error('File changed. Reload before saving.');
      const oldText = new TextDecoder('utf-8', {fatal:true}).decode(old);
      if (old.includes(0)) throw Error('Binary editing unavailable');
      if (req.stagingPath) {
        if (!/^model-context\/workspace-edits\/[a-f0-9-]{36}\.txt$/.test(req.stagingPath)) throw Error('Invalid staging path');
        const privateDir = await directory(root, 'model-context');
        const edits = await directory(privateDir, 'workspace-edits');
        req.content = new TextDecoder('utf-8', {fatal:true}).decode(await bytes(edits, req.stagingPath.split('/').at(-1), 5 * 1024 * 1024));
      }
      const next = Buffer.from(req.content, 'utf8');
      if (next.length > 5 * 1024 * 1024) throw Error('Edit limit is 5 MiB');
      const names = (await readdir(at(store))).filter(n => n.endsWith('.json'));
      if (names.length >= 98) throw Error('Revision limit reached');
      // Both snapshots are durable before replacement; history records captured versions,
      // including a proposed version if replacement was interrupted.
      for (const [version, text] of [[hash(old), oldText], [hash(next), req.content]]) {
        const target = at(store) + '/' + version + '.json';
        let h;
        try { h = await open(target, 'wx', 0o600); }
        catch (e) { if (e.code === 'EEXIST') continue; throw e; }
        try { await h.writeFile(JSON.stringify({version, text, capturedAt: new Date().toISOString()})); await h.sync(); }
        finally { await h.close(); }
      }
      await store.sync();
      const temp = at(parent) + '/.workspace-edit-' + randomUUID();
      const h = await open(temp, 'wx', 0o600);
      try {
        await h.chmod(mode); await h.writeFile(next); await h.sync();
        if (hash(await bytes(parent, name, 5 * 1024 * 1024)) !== req.expectedVersion) throw Error('File changed. Reload before saving.');
        await rename(temp, at(parent) + '/' + name);
        await parent.sync();
      } finally { await h.close(); await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      process.stdout.write(JSON.stringify({version: hash(next)}));
    } else throw Error('Invalid operation');
  }
} catch (e) {
  process.stderr.write(e.code === 'EEXIST' ? 'Another save is active or interrupted; inspect before retrying.' : String(e.message));
  process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await unlink(lockPath); }
  for (const h of handles.reverse()) await h.close();
}
`;
