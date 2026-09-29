/**
 * Blob storage port (docs/design.md §5.1 `Multimodal`, §10): attachments,
 * spilled tool results and PDF text extractions live in object storage; the
 * event log only stores `blob://` URIs (URI + 摘要, never inline content).
 *
 * M4 ships a local-filesystem adapter (single-node topology); an S3/MinIO
 * adapter is a drop-in replacement at the composition root.
 */

/** URI scheme used inside event payloads and content blocks. */
export const BLOB_URI_SCHEME = 'blob://';

export interface BlobMeta {
  /** Opaque storage key (may contain `/`). */
  key: string;
  /** Always `blob://<key>`. */
  uri: string;
  mimeType: string;
  size: number;
}

export interface PutOptions {
  mimeType: string;
}

export interface BlobStore {
  /** Stores `data` under a generated (or supplied) key. */
  put(key: string | undefined, data: Uint8Array, opts: PutOptions): Promise<BlobMeta>;
  /** Resolves a `blob://` URI (or bare key); null when missing. */
  get(uri: string): Promise<Uint8Array | null>;
  getMeta(uri: string): Promise<BlobMeta | null>;
  delete(uri: string): Promise<void>;
}

/** Strips the `blob://` scheme; pass-through for bare keys. */
export function blobKeyOf(uri: string): string {
  return uri.startsWith(BLOB_URI_SCHEME) ? uri.slice(BLOB_URI_SCHEME.length) : uri;
}
