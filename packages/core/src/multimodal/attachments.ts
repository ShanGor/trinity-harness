import type { BlobStore, ContentBlock } from '@trinity-harness/contracts';
import { PDFParse } from 'pdf-parse';

/** Attachment classes the platform ingests (docs/design.md §10 输入). */
export const SUPPORTED_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;
export type SupportedAttachmentType = (typeof SUPPORTED_ATTACHMENT_TYPES)[number];

export function isSupportedAttachmentType(mimeType: string): mimeType is SupportedAttachmentType {
  return (SUPPORTED_ATTACHMENT_TYPES as readonly string[]).includes(mimeType);
}

export interface IngestedAttachment {
  /** Blocks to append to the user message (image/file reference + extraction text). */
  blocks: ContentBlock[];
  /** Human-readable ingestion report (also useful as a log line). */
  summary: string;
}

const PDF_TEXT_MAX_BYTES = 200 * 1024;

function toTextBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Multimodal ingestion (docs/design.md §10): images are stored as-is and
 * referenced from the message; PDFs go through TEXT EXTRACTION — the extracted
 * text is stored as a companion blob and injected as a text block so the
 * model sees the content without burning context on binary page images
 * (page-image rendering is a client-side concern, deferred past M4).
 * The event log never carries content — only `blob://` references.
 */
export async function ingestAttachment(
  blobStore: BlobStore,
  input: { data: Uint8Array; mimeType: string; filename?: string | undefined },
): Promise<IngestedAttachment> {
  if (!isSupportedAttachmentType(input.mimeType)) {
    throw new Error(
      `unsupported attachment type: ${input.mimeType} (supported: ${SUPPORTED_ATTACHMENT_TYPES.join(', ')})`,
    );
  }
  const base = input.filename?.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'attachment';
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (input.mimeType === 'application/pdf') {
    const fileBlob = await blobStore.put(`attachments/${stamp}-${base}`, input.data, {
      mimeType: input.mimeType,
    });
    const text = await extractPdfText(input.data);
    const textBlob = await blobStore.put(`attachments/${stamp}-${base}.txt`, toTextBytes(text), {
      mimeType: 'text/plain; charset=utf-8',
    });
    const preview = text.slice(0, 500);
    return {
      blocks: [
        {
          kind: 'text',
          text: `[attachment: ${base} (application/pdf, ${input.data.byteLength} bytes) — extracted text below; full document at ${fileBlob.uri}, extraction at ${textBlob.uri}]\n${preview}`,
        },
        { kind: 'file', uri: fileBlob.uri, mimeType: input.mimeType },
      ],
      summary: `pdf "${base}": ${input.data.byteLength} bytes, ${text.length} chars of text extracted`,
    };
  }

  const blob = await blobStore.put(`attachments/${stamp}-${base}`, input.data, {
    mimeType: input.mimeType,
  });
  return {
    blocks: [
      { kind: 'image', uri: blob.uri, mimeType: input.mimeType },
      {
        kind: 'text',
        text: `[attachment: ${base} (${input.mimeType}, ${input.data.byteLength} bytes)]`,
      },
    ],
    summary: `image "${base}": ${input.data.byteLength} bytes stored at ${blob.uri}`,
  };
}

/** pdf-parse (pure TS, M4 dependency) text extraction with bounded output. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  // pdf-parse transfers/detaches the input ArrayBuffer — hand it a copy so
  // the caller's bytes stay intact (they may still be stored/served).
  const parser = new PDFParse({ data: data.slice() });
  try {
    const result = await parser.getText();
    const text = result.text ?? '';
    return text.length > PDF_TEXT_MAX_BYTES
      ? `${text.slice(0, PDF_TEXT_MAX_BYTES)}\n…[truncated]`
      : text;
  } finally {
    await parser.destroy();
  }
}
