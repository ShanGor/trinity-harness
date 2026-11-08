import { z } from 'zod';
import type { BlobMeta } from './blob.js';

export const attachmentRecordSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  operationId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  mimeType: z.string().min(1).max(100),
  filename: z.string().max(200),
  origin: z.enum(['file', 'paste']),
  workspacePath: z.string().min(1).max(500),
  writeStarted: z.boolean(),
});
export type AttachmentRecord = z.infer<typeof attachmentRecordSchema>;
export const attachmentUploadResponseSchema = z.object({
  uri: z.string().startsWith('blob://'),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  workspacePath: z.string(),
});
export type AttachmentUploadResponse = z.infer<typeof attachmentUploadResponseSchema>;
export const attachmentUploadErrorSchema = z.object({
  error: z.string().min(1).max(500),
  code: z
    .enum(['ATTACHMENT_CONFLICT', 'ATTACHMENT_WRITE_UNCERTAIN', 'ATTACHMENT_UNAVAILABLE'])
    .optional(),
});

/** Durable ingestion journal; session ownership is checked before entering this port. */
export interface AttachmentCatalog {
  run<T>(
    sessionId: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  find(sessionId: string, operationId: string): Promise<AttachmentRecord | null>;
  get(id: string): Promise<AttachmentRecord | null>;
  save(record: AttachmentRecord): Promise<void>;
  ready(sha256: string, size: number): Promise<void>;
}
export interface AttachmentReader {
  get(sessionId: string, uri: string): Promise<Uint8Array | null>;
  meta(sessionId: string, uri: string): Promise<BlobMeta | null>;
}
