import { createHash } from 'node:crypto';
import type {
  BrowserDocumentManifest,
  BrowserMarkdownExport,
  ToolContext,
} from '@trinity-harness/contracts';
import { browserMarkdownExportSchema } from '@trinity-harness/contracts';
import { documentConversionHtml, documentHash } from './browser-documents.js';
import { BrowserDriverError } from './browser-driver-error.js';
import {
  browserHtmlToMarkdown,
  browserHtmlConverterVersion,
  browserHtmlConverterOptions,
} from './browser-html-markdown.js';
import type { ReadFileOptions } from '@trinity-harness/contracts';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

/** All effects use the originating workspace Sandbox, including in Firecracker mode. */
export async function exportDocumentBundle(
  manifest: BrowserDocumentManifest,
  ctx: ToolContext,
  recheck: () => Promise<void>,
  markEffect: () => void,
  markdown: boolean,
): Promise<{ path: string; markdown?: BrowserMarkdownExport }> {
  const sandbox = ctx.sandbox.withSignal?.(ctx.signal) ?? ctx.sandbox;
  if (!ctx.permissionGranted) throw new BrowserDriverError('NOT_AUTHORIZED');
  if (!ctx.callId || !sandbox.execArgv || !sandbox.writeBytes)
    throw new BrowserDriverError(
      'DISABLED',
      'Export requires bounded argv and binary workspace file capabilities.',
    );
  const path =
    'browser-capture-' + createHash('sha256').update(ctx.callId).digest('hex').slice(0, 32);
  await recheck();
  markEffect();
  const created = await sandbox.execArgv(
    'node',
    [
      '-e',
      "const fs=require('node:fs');fs.mkdirSync(process.argv[1],{mode:0o700});fs.mkdirSync(process.argv[1]+'/media',{mode:0o700})",
      path,
    ],
    { maxOutputBytes: 2048, timeoutMs: 5000, signal: ctx.signal },
  );
  if (created.exitCode !== 0 || created.outputOverflow)
    throw new BrowserDriverError(
      'NOT_EXECUTED',
      'The generated export directory could not be created. Existing exports are never overwritten.',
    );
  let bytesWritten = 0;
  const write = async (file: string, bytes: Uint8Array): Promise<void> => {
    await recheck();
    ctx.signal?.throwIfAborted();
    bytesWritten += bytes.byteLength;
    if (bytesWritten > MAX_EXPORT_BYTES || bytes.byteLength > MAX_FILE_BYTES)
      throw new BrowserDriverError(
        'LIMIT_REACHED',
        `Export file/aggregate byte limit reached. Inspect the partial bundle at ${path}; do not repeat the export automatically.`,
      );
    await sandbox.writeBytes!(path + '/' + file, bytes);
  };
  const assets = new Set<string>();
  for (const doc of manifest.documents) {
    await write(
      doc.documentId + '.html',
      Buffer.from(documentConversionHtml(manifest, doc.documentId)),
    );
    await write(
      doc.documentId + '.structure.json',
      Buffer.from(
        JSON.stringify({
          ...doc,
          resources: doc.resources.map(({ data, ...resource }) => ({
            ...resource,
            ...(data ? { file: 'media/' + documentHash(data) + '.png' } : {}),
          })),
        }),
      ),
    );
    for (const resource of doc.resources)
      if (resource.data) {
        const file = 'media/' + documentHash(resource.data) + '.png';
        if (!assets.has(file)) {
          await write(file, Buffer.from(resource.data.split(',')[1]!, 'base64'));
          assets.add(file);
        }
      }
  }
  // A real saved HTML file is the converter's only input. Child documents occur at
  // their iframe owners; captured images use local media files, never remote src URLs.
  const html = documentConversionHtml(manifest);
  const inputHash = createHash('sha256').update(html).digest('hex');
  await write('content.html', Buffer.from(html));
  const provenance = {
    captureId: manifest.captureId,
    captureHash: manifest.hash,
    coverage: 'unverified',
    omittedFrames: manifest.omittedFrames,
    sourceHashes: manifest.hashes,
    documents: manifest.documents.map((doc) => ({
      documentId: doc.documentId,
      parentDocumentId: doc.parentDocumentId,
      ownerNodeId: doc.ownerNodeId,
      url: doc.url,
      title: doc.title,
      revision: doc.revision,
      exclusions: doc.exclusions,
      truncated: doc.truncated,
      html: doc.documentId + '.html',
      structure: doc.documentId + '.structure.json',
      resources: doc.resources.map(({ data, ...resource }) => ({
        ...resource,
        ...(data ? { file: 'media/' + documentHash(data) + '.png' } : {}),
      })),
    })),
    input: { file: 'content.html', sha256: inputHash, composition: 'frame-owner-order-v1' },
  };
  await write(
    'manifest.json',
    Buffer.from(JSON.stringify({ ...provenance, conversion: null }, null, 2)),
  );
  if (!markdown) {
    await recheck();
    return { path };
  }
  const verifyInput = async (): Promise<void> => {
    await recheck();
    // Hash inside the Sandbox: existing binary-read transport is smaller than
    // a composed HTML file. Fixed streaming code returns only a bounded digest.
    const checked = await sandbox.execArgv!(
      'node',
      [
        '-e',
        "const fs=require('node:fs'),crypto=require('node:crypto');const fd=fs.openSync('content.html',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>67108864)process.exitCode=1;else{const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);let total=0,n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){total+=n;if(total>67108864)throw new Error('limit');hash.update(buffer.subarray(0,n));}process.stdout.write(hash.digest('hex'));}}finally{fs.closeSync(fd)}",
      ],
      { cwd: path, maxOutputBytes: 1024, timeoutMs: 5000, signal: ctx.signal },
    );
    ctx.signal?.throwIfAborted();
    if (checked.exitCode !== 0 || checked.outputOverflow || checked.stdout.trim() !== inputHash)
      throw new BrowserDriverError(
        'ARTIFACT_UNAVAILABLE',
        'Saved conversion input changed. Retain the HTML bundle for inspection; no Markdown was published.',
      );
  };
  await verifyInput();
  // Read the saved file through bounded, version-fenced Sandbox pages. Never
  // substitute the in-memory renderer output for the materialized HTML input.
  let savedHtml = '';
  let cursor: ReadFileOptions['cursor'];
  do {
    await recheck();
    ctx.signal?.throwIfAborted();
    const page = await sandbox.readFile(path + '/content.html', {
      maxBytes: 1024 * 1024,
      limit: 2000,
      ...(cursor ? { cursor } : {}),
      signal: ctx.signal,
    });
    savedHtml += page.content;
    if (Buffer.byteLength(savedHtml) > MAX_FILE_BYTES)
      throw new BrowserDriverError(
        'LIMIT_REACHED',
        'Saved HTML exceeds the conversion input limit.',
      );
    if (
      page.truncated &&
      (!page.continuation || page.continuation.byteOffset <= (cursor?.byteOffset ?? 0))
    )
      throw new BrowserDriverError('INVALID_OUTPUT', 'Saved HTML read did not advance its cursor.');
    cursor = page.truncated ? page.continuation : undefined;
  } while (cursor);
  if (createHash('sha256').update(savedHtml).digest('hex') !== inputHash)
    throw new BrowserDriverError(
      'ARTIFACT_UNAVAILABLE',
      'Saved conversion input changed. No Markdown was published.',
    );
  const converted = await browserHtmlToMarkdown(savedHtml, ctx.signal);
  ctx.signal?.throwIfAborted();
  await verifyInput();
  const warnings = converted.warnings;
  await write('content.md', Buffer.from(converted.text));
  await write(
    'manifest.json',
    Buffer.from(
      JSON.stringify(
        {
          ...provenance,
          conversion: {
            converter: 'turndown',
            version: browserHtmlConverterVersion,
            input: 'content.html',
            extensions: ['gfm'],
            options: browserHtmlConverterOptions,
            output: 'content.md',
            outputHash: createHash('sha256').update(converted.text).digest('hex'),
            warnings,
            warningCodes: converted.warningCodes,
            sourceMappings: 'document-and-node-identities-in-html-only',
          },
        },
        null,
        2,
      ),
    ),
  );
  await recheck();
  return {
    path,
    markdown: browserMarkdownExportSchema.parse({
      kind: 'browser-markdown-export',
      path: path + '/content.md',
      bundlePath: path,
      captureId: manifest.captureId,
      converter: 'turndown',
      converterVersion: browserHtmlConverterVersion,
      inputHash,
      outputHash: createHash('sha256').update(converted.text).digest('hex'),
      outputBytes: Buffer.byteLength(converted.text),
      limitations: {
        omittedFrames: manifest.omittedFrames,
        savedMediaFiles: assets.size,
        truncatedDocuments: manifest.documents.filter((doc) => doc.truncated).length,
        inlineSvg: manifest.documents
          .flatMap((doc) => doc.resources)
          .filter((resource) => resource.role === 'svg').length,
        unavailableResources: manifest.documents
          .flatMap((doc) => doc.resources)
          .filter((resource) => !['captured', 'inline'].includes(resource.state)).length,
      },
      warnings,
      warningCodes: converted.warningCodes,
      coverage: 'unverified',
    }),
  };
}
