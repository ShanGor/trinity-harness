import { attachmentRecordSchema } from '@trinity-harness/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AttachmentCatalog,
  AttachmentReader,
  AttachmentRecord,
  AttachmentUploadResponse,
  BlobMeta,
  BlobStore,
  SandboxPort,
  SessionStore,
} from '@trinity-harness/contracts';
import { LocalSandbox } from '../sandbox/local-sandbox.js';
import { saveWorkspaceAttachment } from '../session/workspace.js';

export const ATTACHMENT_POOL = 'attachment-pool/';
export const ATTACHMENT_ALIAS = 'attachment/';
const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const poolKey = (record: Pick<AttachmentRecord, 'sha256' | 'size'>): string =>
  `${ATTACHMENT_POOL}${record.sha256}-${record.size}`;
const uriOf = (record: AttachmentRecord): string =>
  `blob://${ATTACHMENT_ALIAS}${record.sessionId}/${record.id}`;

/** In-memory fixture/development mode only, matching MemorySessionStore lifetime. */
export class MemoryAttachmentCatalog implements AttachmentCatalog {
  private readonly records = new Map<string, AttachmentRecord>();
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(
    sessionId: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        signal?.throwIfAborted();
        return action(signal ?? new AbortController().signal);
      });
    this.tails.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId);
    }
  }
  async find(sessionId: string, operationId: string): Promise<AttachmentRecord | null> {
    return (
      [...this.records.values()].find(
        (r) => r.sessionId === sessionId && r.operationId === operationId,
      ) ?? null
    );
  }
  async get(id: string): Promise<AttachmentRecord | null> {
    return this.records.get(id) ?? null;
  }
  async save(record: AttachmentRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }
  async ready(): Promise<void> {
    /* Files are the dev pool's authority. */
  }
}

/** Original bytes are globally shared; all externally usable handles remain session scoped. */
export class AttachmentService implements AttachmentReader {
  constructor(
    private readonly blobs: BlobStore,
    private readonly catalog: AttachmentCatalog,
    private readonly events: SessionStore,
  ) {}

  async upload(input: {
    sessionId: string;
    operationId: string;
    data: Uint8Array;
    mimeType: string;
    filename: string;
    origin: 'file' | 'paste';
    workspaceRoot: string;
    sandbox?: SandboxPort;
    actor?: string;
    signal?: AbortSignal;
  }): Promise<AttachmentUploadResponse> {
    if (input.origin === 'paste' && input.mimeType !== 'text/plain')
      throw new Error('Paste requires UTF-8 text');
    const sha256 = digest(input.data);
    const size = input.data.byteLength;
    if (!this.blobs.putImmutable) throw new Error('Immutable attachment storage unavailable');
    if (input.mimeType === 'text/plain')
      new TextDecoder('utf-8', { fatal: true }).decode(input.data);
    return this.catalog.run(
      input.sessionId,
      async (signal) => {
        signal.throwIfAborted();
        const baseSandbox: SandboxPort = input.sandbox ?? new LocalSandbox(input.workspaceRoot);
        const sandbox = baseSandbox.withSignal?.(signal) ?? baseSandbox;
        const history = await this.events.load(input.sessionId);
        if (history.some((event) => event.type === 'session/closed'))
          throw new Error('Session closed');
        let record = await this.catalog.find(input.sessionId, input.operationId);
        if (
          record &&
          (record.sha256 !== sha256 ||
            record.size !== size ||
            record.mimeType !== input.mimeType ||
            record.filename !== input.filename ||
            record.origin !== input.origin)
        )
          throw Object.assign(new Error('Upload operation already belongs to different content'), {
            code: 'ATTACHMENT_CONFLICT',
          });
        if (!record) {
          const id = randomUUID();
          const name = input.filename.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120);
          record = {
            id,
            sessionId: input.sessionId,
            operationId: input.operationId,
            sha256,
            size,
            mimeType: input.mimeType,
            filename: input.filename,
            origin: input.origin,
            workspacePath: `uploads/${id}-${name}`,
            writeStarted: false,
          };
          record = attachmentRecordSchema.parse(record);
          await this.catalog.save(record);
        }
        const committed = history.some(
          (event) => event.type === 'session/attachment' && event.attachmentId === record!.id,
        );
        if (committed) return this.response(record);
        await this.blobs.putImmutable!(poolKey(record), input.data);
        await this.catalog.ready(sha256, size);
        signal.throwIfAborted();
        if (record.writeStarted) {
          // Unknown writes are never repeated. Reconcile the exact reserved path or fail closed.
          if (!(await this.matches(sandbox, record)))
            throw Object.assign(
              new Error(
                'Upload workspace write is uncertain; inspect the reserved file before retrying',
              ),
              { code: 'ATTACHMENT_WRITE_UNCERTAIN' },
            );
        } else {
          record = { ...record, writeStarted: true };
          await this.catalog.save(record);
          await saveWorkspaceAttachment(
            input.workspaceRoot,
            input.data,
            input.filename,
            sandbox,
            record.id,
          );
        }
        signal.throwIfAborted();
        await this.events.append(
          input.sessionId,
          [
            {
              type: 'session/attachment',
              eventId: record.id,
              at: new Date().toISOString(),
              uri: uriOf(record),
              workspacePath: record.workspacePath,
              mimeType: record.mimeType,
              size,
              attachmentId: record.id,
              sha256,
              filename: record.filename,
              origin: record.origin,
            },
          ],
          { actor: input.actor ?? 'system' },
        );
        return this.response(record);
      },
      input.signal,
    );
  }
  private response(record: AttachmentRecord): AttachmentUploadResponse {
    return {
      uri: uriOf(record),
      mimeType: record.mimeType,
      size: record.size,
      workspacePath: record.workspacePath,
    };
  }
  private async matches(sandbox: SandboxPort, record: AttachmentRecord): Promise<boolean> {
    if (!sandbox.readBytes) return false;
    try {
      const bytes = await sandbox.readBytes(record.workspacePath, record.size + 1);
      return bytes.length === record.size && digest(bytes) === record.sha256;
    } catch {
      return false;
    } // No reuse authority on unavailable/missing/edited copies.
  }
  async record(sessionId: string, uri: string): Promise<AttachmentRecord | null> {
    const match = /^blob:\/\/attachment\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(uri);
    if (
      !match ||
      match[1] !== sessionId ||
      !attachmentRecordSchema.shape.id.safeParse(match[2]).success
    )
      return null;
    const record = await this.catalog.get(match[2]!);
    if (!record || record.sessionId !== sessionId || uriOf(record) !== uri) return null;
    const events = await this.events.load(sessionId);
    return events.some(
      (e) => e.type === 'session/attachment' && e.attachmentId === record.id && e.uri === uri,
    )
      ? record
      : null;
  }
  async get(sessionId: string, uri: string): Promise<Uint8Array | null> {
    const record = await this.record(sessionId, uri);
    if (!record) return null;
    const bytes = await this.blobs.get(`blob://${poolKey(record)}`);
    if (!bytes || bytes.length !== record.size || digest(bytes) !== record.sha256)
      throw new Error('Original attachment unavailable');
    return bytes;
  }
  async meta(sessionId: string, uri: string): Promise<BlobMeta | null> {
    const record = await this.record(sessionId, uri);
    return record ? { key: uri.slice(7), uri, mimeType: record.mimeType, size: record.size } : null;
  }
}

/** Used at tool/provider read boundaries; ordinary historical spills retain their own rules. */
export async function readAttachmentBlob(
  blobs: BlobStore,
  reader: AttachmentReader | undefined,
  sessionId: string,
  uri: string,
  events?: SessionStore,
): Promise<Uint8Array | null> {
  const key = decodeURIComponent(uri.replace(/^blob:\/\//, ''));
  if (key.split('/').some((part) => ['attachment-pool', 'model-context', '..'].includes(part)))
    throw new Error('Attachment pool is private');
  if (key.startsWith(ATTACHMENT_ALIAS)) return reader ? reader.get(sessionId, uri) : null;
  if (events) {
    const metadata = await blobs.getMeta(uri);
    if (
      metadata &&
      (metadata.mimeType.startsWith('image/') ||
        metadata.mimeType === 'application/pdf' ||
        key.startsWith('attachments/'))
    ) {
      const history = await events.load(sessionId);
      if (!hasAttachmentReference(history, uri)) return null;
    }
  }
  return blobs.get(uri);
}
export function hasAttachmentReference(
  history: Awaited<ReturnType<SessionStore['load']>>,
  uri: string,
): boolean {
  return history.some(
    (event) =>
      (event.type === 'session/attachment' && event.uri === uri) ||
      ((event.type === 'message/user' || event.type === 'prompt/queued') &&
        event.content.some(
          (block) => (block.kind === 'file' || block.kind === 'image') && block.uri === uri,
        )),
  );
}
