import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BROWSER_DOCUMENT_LIMITS as LIMITS,
  browserRenderedDocumentSchema,
  type BrowserDocumentGraph,
  type BrowserRenderedDocument,
} from '@trinity-harness/contracts';
import { BrowserDriverError } from './browser-driver-error.js';
import { zendriverStructured, type ZendriverClient } from './zendriver-mcp.js';
import {
  documentCaptureScript,
  documentChunkScript,
  documentReleaseScript,
} from './browser-document-script.js';
import { validateDocumentGraph } from './browser-documents.js';

const frameTree = z.object({
  capture_protocol: z.literal('rendered-document-v1'),
  build_id: z.literal('trinity-document-v1'),
  frames: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        url: z.string().max(2000),
        parent_id: z.string().nullable(),
        is_main: z.boolean(),
        owner_path: z.array(z.number().int().min(-1)).max(80).nullable(),
      }),
    )
    .max(100),
});
/** No guessed URLs/owner paths, resource refetch, scrolling or effect retries. */
export async function captureRenderedDocuments(
  client: ZendriverClient,
  signal?: AbortSignal,
): Promise<BrowserDocumentGraph> {
  const active = AbortSignal.any([
    AbortSignal.timeout(LIMITS.deadlineMs),
    ...(signal ? [signal] : []),
  ]);
  const startedAt = new Date().toISOString();
  const raw = zendriverStructured(await client.call('browser_frame_list', {}, active));
  const capability = z
    .object({ capture_protocol: z.string().optional(), build_id: z.string().optional() })
    .parse(raw);
  if (
    capability.capture_protocol !== 'rendered-document-v1' ||
    capability.build_id !== 'trinity-document-v1'
  )
    throw new BrowserDriverError(
      'DISABLED',
      'Rendered document capture requires the matching guest application and patched browser build.',
    );
  const parsedTree = frameTree.parse(raw);
  const frames = parsedTree.frames;
  const main = frames.filter((f) => f.is_main);
  if (
    main.length !== 1 ||
    frames.some((f) => f !== main[0] && f.parent_id === null) ||
    new Set(frames.map((f) => f.id)).size !== frames.length
  )
    throw new BrowserDriverError('INVALID_OUTPUT');
  const evaluate = async (frameId: string, expression: string): Promise<unknown> =>
    z
      .object({ value: z.unknown() })
      .parse(
        zendriverStructured(
          await client.call('browser_evaluate', { frame_id: frameId, expression }, active),
        ),
      ).value;
  const documents: BrowserRenderedDocument[] = [];
  const capturedFrames = new Set<string>();
  const frameDocuments = new Map<string, string>();
  const omittedReasons = new Map<
    string,
    'document-limit' | 'depth-limit' | 'byte-limit' | 'frame-owner-unavailable'
  >();
  const opened: { frameId: string; key: string }[] = [];
  const queue = [
    {
      frame: main[0]!,
      parent: null as BrowserRenderedDocument | null,
      ownerNodeId: null as string | null,
      depth: 0,
    },
  ];
  let total = 0,
    assets = 0,
    omitted = 0;
  try {
    while (queue.length) {
      active.throwIfAborted();
      const { frame, parent, ownerNodeId, depth } = queue.shift()!;
      if (documents.length >= LIMITS.documents || depth > LIMITS.depth) {
        omitted++;
        omittedReasons.set(frame.id, depth > LIMITS.depth ? 'depth-limit' : 'document-limit');
        continue;
      }
      const key = '__trinity_capture_' + randomUUID().replaceAll('-', ''),
        revision = randomUUID();
      // Release attempts even when transfer fails; an unavailable channel is disposed by the supervisor.
      opened.push({ frameId: frame.id, key });
      const header = await evaluate(
        frame.id,
        documentCaptureScript(key, revision, LIMITS.assets - assets),
      );
      if (z.object({ denied: z.literal(true) }).safeParse(header).success)
        throw new BrowserDriverError('PRIVACY_DENIED');
      if (z.object({ limit: z.literal(true) }).safeParse(header).success)
        throw new BrowserDriverError('LIMIT_REACHED');
      const size = z
        .object({
          length: z.number().int().min(1).max(LIMITS.documentBytes),
          bytes: z.number().int().min(1).max(LIMITS.documentBytes),
          revision: z.literal(revision),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(header);
      if (total + size.bytes > LIMITS.totalBytes) {
        omitted++;
        omittedReasons.set(frame.id, 'byte-limit');
        continue;
      }
      let text = '';
      const chunks: { ordinal: number; bytes: number; hash: string }[] = [];
      for (let offset = 0; offset < size.length; offset += 8000) {
        const raw = await evaluate(frame.id, documentChunkScript(key, revision, offset));
        if (z.object({ stale: z.literal(true) }).safeParse(raw).success)
          throw new BrowserDriverError(
            'STALE_TARGET',
            'Document changed during capture. Obtain a new capture; no interaction was repeated.',
          );
        const part = z
          .object({
            offset: z.literal(offset),
            revision: z.literal(revision),
            bytes: z.number().int().positive().max(LIMITS.chunkBytes),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            text: z.string().min(1).max(8000),
          })
          .parse(raw);
        if (part.text.length !== Math.min(8000, size.length - offset))
          throw new BrowserDriverError('INVALID_OUTPUT');
        const bytes = Buffer.byteLength(part.text);
        if (
          bytes > LIMITS.chunkBytes ||
          bytes !== part.bytes ||
          createHash('sha256').update(part.text).digest('hex') !== part.hash
        )
          throw new BrowserDriverError('INVALID_OUTPUT');
        chunks.push({
          ordinal: chunks.length,
          bytes,
          hash: createHash('sha256').update(part.text).digest('hex'),
        });
        text += part.text;
      }
      // The complete hash is persisted with the manifest; chunk hashes are transfer checks only.
      if (
        Buffer.byteLength(text) !== size.bytes ||
        createHash('sha256').update(text).digest('hex') !== size.hash ||
        chunks.some((c, i) => c.ordinal !== i)
      )
        throw new BrowserDriverError('INVALID_OUTPUT');
      const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
      if (payload.url === null) payload.url = parent?.url;
      const doc = browserRenderedDocumentSchema.parse({
        ...payload,
        documentId: 'd' + documents.length,
        parentDocumentId: parent?.documentId ?? null,
        ownerNodeId,
      });
      total += size.bytes;
      assets += doc.resources.length;
      if (assets > LIMITS.assets)
        throw new BrowserDriverError('LIMIT_REACHED', 'Resource inventory limit reached.');
      documents.push(doc);
      capturedFrames.add(frame.id);
      frameDocuments.set(frame.id, doc.documentId);
      for (const child of frames.filter((f) => f.parent_id === frame.id && !f.is_main)) {
        const owner =
          child.owner_path === null
            ? undefined
            : doc.nodes.find(
                (n) =>
                  n.tag === 'iframe' && JSON.stringify(n.path) === JSON.stringify(child.owner_path),
              );
        if (!owner) {
          omitted++;
          omittedReasons.set(child.id, 'frame-owner-unavailable');
          continue;
        }
        queue.push({ frame: child, parent: doc, ownerNodeId: owner.id, depth: depth + 1 });
      }
    }
    const after = frameTree.parse(
      zendriverStructured(await client.call('browser_frame_list', {}, active)),
    );
    if (JSON.stringify(after.frames) !== JSON.stringify(frames))
      throw new BrowserDriverError(
        'STALE_TARGET',
        'Frame graph changed during capture. No interaction was repeated.',
      );
    for (const { frameId, key } of opened) {
      const checked = z
        .object({ stale: z.boolean() })
        .parse(await evaluate(frameId, documentReleaseScript(key, true)));
      if (checked.stale)
        throw new BrowserDriverError(
          'STALE_TARGET',
          'Document mutated during transfer. Nothing was published.',
        );
    }
    return validateDocumentGraph({
      protocol: 'rendered-document-v1',
      buildId: 'trinity-document-v1',
      startedAt,
      finishedAt: new Date().toISOString(),
      documents,
      omittedFrames: Math.max(omitted, frames.filter((f) => !capturedFrames.has(f.id)).length),
      omissions: frames
        .filter((f) => !capturedFrames.has(f.id))
        .map((f, i) => ({
          scopeId: 'f' + i,
          parentDocumentId: frameDocuments.get(f.parent_id ?? '') ?? null,
          reason: omittedReasons.get(f.id) ?? 'frame-unavailable',
        })),
      stability: 'checked-interval',
    });
  } finally {
    // Sequential cleanup preserves the single MCP request invariant. Cancellation/channel faults propagate.
    if (!active.aborted)
      for (const { frameId, key } of opened)
        await evaluate(frameId, documentReleaseScript(key, false));
  }
}
