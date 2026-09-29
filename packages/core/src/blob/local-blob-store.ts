import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BlobMeta, BlobStore } from '@trinity-harness/contracts';
import { BLOB_URI_SCHEME, blobKeyOf } from '@trinity-harness/contracts';

/**
 * Filesystem BlobStore adapter (M4, docs/design.md §10): stores blobs under
 * `<root>/<key>`. Fits the single-node topology (server + worker share the
 * workspace disk); an S3/MinIO adapter implements the same BlobStore port.
 */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    const abs = path.resolve(this.root, key);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`blob key escapes store root: ${key}`);
    }
    return abs;
  }

  async put(
    key: string | undefined,
    data: Uint8Array,
    opts: { mimeType: string },
  ): Promise<BlobMeta> {
    const finalKey = key ?? randomUUID();
    const abs = this.abs(finalKey);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    // Sidecar metadata so getMeta can serve the original MIME type back
    // (blobs are opaque bytes; the content-type matters for the UI).
    await writeFile(`${abs}.meta.json`, JSON.stringify({ mimeType: opts.mimeType }), 'utf8');
    return {
      key: finalKey,
      uri: `${BLOB_URI_SCHEME}${finalKey}`,
      mimeType: opts.mimeType,
      size: data.byteLength,
    };
  }

  async get(uri: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.abs(blobKeyOf(uri)));
      // Plain Uint8Array (readFile returns a Buffer subclass — normalize so
      // cross-process consumers see a stable type).
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async getMeta(uri: string): Promise<BlobMeta | null> {
    const key = blobKeyOf(uri);
    try {
      const info = await stat(this.abs(key));
      let mimeType = 'application/octet-stream';
      try {
        const sidecar = JSON.parse(await readFile(`${this.abs(key)}.meta.json`, 'utf8')) as {
          mimeType?: string;
        };
        if (typeof sidecar.mimeType === 'string') mimeType = sidecar.mimeType;
      } catch {
        // No sidecar (e.g. hand-placed file) — octet-stream default.
      }
      return { key, uri: `${BLOB_URI_SCHEME}${key}`, mimeType, size: info.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(uri: string): Promise<void> {
    try {
      await unlink(this.abs(blobKeyOf(uri)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
