import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createReadBlobTool,
  extractPdfText,
  ingestAttachment,
  isSupportedAttachmentType,
  LocalBlobStore,
} from '../src/index.js';

/** Minimal valid single-page PDF with uncompressed text content. */
function makeTestPdf(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${content.length}>>stream`,
    content,
    'endstream',
    'endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  return new TextEncoder().encode(pdf);
}

let dir: string;
let blobs: LocalBlobStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'trinity-blob-'));
  blobs = new LocalBlobStore(path.join(dir, 'blobs'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalBlobStore', () => {
  it('round-trips bytes behind blob:// URIs', async () => {
    const data = new TextEncoder().encode('hello blob');
    const meta = await blobs.put(undefined, data, { mimeType: 'text/plain' });
    expect(meta.uri).toBe(`blob://${meta.key}`);
    expect(await blobs.get(meta.uri)).toEqual(data);
    expect((await blobs.getMeta(meta.uri))?.size).toBe(data.byteLength);
    await blobs.delete(meta.uri);
    expect(await blobs.get(meta.uri)).toBeNull();
  });

  it('rejects path-escaping keys', async () => {
    await expect(
      blobs.put('../../etc/passwd', new Uint8Array(1), { mimeType: 'text/plain' }),
    ).rejects.toThrow(/escapes/);
  });
});

describe('ingestAttachment (docs/design.md §10)', () => {
  it('stores images and returns an image block plus a caption', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const ingested = await ingestAttachment(blobs, {
      data: png,
      mimeType: 'image/png',
      filename: 'shot.png',
    });
    expect(ingested.blocks[0]).toEqual(
      expect.objectContaining({ kind: 'image', mimeType: 'image/png' }),
    );
    expect((ingested.blocks[0] as { uri: string }).uri).toMatch(/^blob:\/\//);
    expect(ingested.blocks[1]).toEqual(expect.objectContaining({ kind: 'text' }));
    // Content is retrievable from the store — the log only holds the URI.
    const stored = await blobs.get((ingested.blocks[0] as { uri: string }).uri);
    expect(stored).toEqual(png);
  });

  it('extracts PDF text into a companion blob and injects it as a text block', async () => {
    const pdf = makeTestPdf('Hello PDF World');
    const ingested = await ingestAttachment(blobs, {
      data: pdf,
      mimeType: 'application/pdf',
      filename: 'spec.pdf',
    });
    const fileBlock = ingested.blocks.find((b) => b.kind === 'file');
    const textBlock = ingested.blocks.find((b) => b.kind === 'text');
    expect(fileBlock).toEqual(
      expect.objectContaining({ kind: 'file', mimeType: 'application/pdf' }),
    );
    expect(textBlock).toEqual(
      expect.objectContaining({ kind: 'text', text: expect.stringContaining('Hello PDF World') }),
    );
    // The full PDF bytes are stored; the extraction text is a separate blob.
    const storedPdf = await blobs.get((fileBlock as { uri: string }).uri);
    expect(storedPdf).toEqual(pdf);
    expect(ingested.summary).toContain('chars of text extracted');
  });

  it('rejects unsupported MIME types at the boundary', async () => {
    expect(isSupportedAttachmentType('image/png')).toBe(true);
    expect(isSupportedAttachmentType('application/x-msdownload')).toBe(false);
    await expect(
      ingestAttachment(blobs, { data: new Uint8Array(4), mimeType: 'application/x-msdownload' }),
    ).rejects.toThrow(/unsupported attachment type/);
  });

  it('extractPdfText works standalone (pure TS parser, no native deps)', async () => {
    const text = await extractPdfText(makeTestPdf('Standalone extraction'));
    expect(text).toContain('Standalone extraction');
  });
});

describe('read_blob tool', () => {
  it('fetches spilled/attachment content with truncation', async () => {
    const meta = await blobs.put(undefined, new TextEncoder().encode('x'.repeat(10_000)), {
      mimeType: 'application/json',
    });
    const tool = createReadBlobTool(blobs);
    const full = await tool.execute(tool.parameters.parse({ uri: meta.uri }), {
      sessionId: 's1',
      workspaceRoot: '/ws',
      sandbox: {} as never,
    });
    expect(full.isError).toBe(false);
    expect((full.value as { bytes: number; truncated: boolean }).bytes).toBe(10_000);

    const truncated = await tool.execute(tool.parameters.parse({ uri: meta.uri, maxBytes: 100 }), {
      sessionId: 's1',
      workspaceRoot: '/ws',
      sandbox: {} as never,
    });
    expect((truncated.value as { truncated: boolean }).truncated).toBe(true);
  });

  it('fails closed on non-blob URIs and missing blobs', async () => {
    const tool = createReadBlobTool(blobs);
    const bad = await tool.execute(tool.parameters.parse({ uri: 'https://evil.example/x' }), {
      sessionId: 's1',
      workspaceRoot: '/ws',
      sandbox: {} as never,
    });
    expect(bad.isError).toBe(true);
    const missing = await tool.execute(tool.parameters.parse({ uri: 'blob://nope' }), {
      sessionId: 's1',
      workspaceRoot: '/ws',
      sandbox: {} as never,
    });
    expect(missing.isError).toBe(true);
  });
});

describe('end-to-end: ingest → read back from disk', () => {
  it('survives a store re-instantiation (durable on the shared filesystem)', async () => {
    const pdf = makeTestPdf('Durable bytes');
    const file = path.join(dir, 'upload.pdf');
    await writeFile(file, pdf);
    const first = new LocalBlobStore(path.join(dir, 'blobs'));
    const ingested = await ingestAttachment(first, {
      data: new Uint8Array(await readFile(file)),
      mimeType: 'application/pdf',
      filename: 'upload.pdf',
    });
    const second = new LocalBlobStore(path.join(dir, 'blobs')); // "other process"
    const uri = (ingested.blocks.find((b) => b.kind === 'file') as { uri: string }).uri;
    expect(await second.get(uri)).toEqual(pdf);
  });
});
