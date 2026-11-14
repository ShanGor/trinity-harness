import { z } from 'zod';
import {
  browserPresentationSchema,
  browserVectorAttributesSchema,
} from './browser-document-presentation.js';

/** Pilot writer quota, including inaccessible orphans; conservative retention, no automatic GC. */
export const BROWSER_DOCUMENT_LIMITS = {
  documents: 20,
  depth: 3,
  documentBytes: 2 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  nodes: 20000,
  assets: 100,
  assetBytes: 5 * 1024 * 1024,
  assetTotalBytes: 25 * 1024 * 1024,
  deadlineMs: 30000,
  capturesPerSession: 8,
} as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const safeUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !Array.from(u.searchParams.keys()).some((k) =>
          /token|secret|password|api[-_]?key|authorization|^code$/i.test(k),
        )
      );
    } catch {
      return false;
    }
  });
export const browserDocumentNodeSchema = z.object({
  id,
  parentId: id.nullable(),
  tag: z.enum([
    'text',
    'html',
    'body',
    'div',
    'section',
    'article',
    'main',
    'header',
    'footer',
    'nav',
    'aside',
    'p',
    'span',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'pre',
    'code',
    'blockquote',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'a',
    'strong',
    'em',
    'b',
    'i',
    'br',
    'hr',
    'img',
    'figure',
    'figcaption',
    'iframe',
    'shadow',
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'svg-text',
    'tspan',
    'canvas',
    'video',
    'audio',
    'picture',
    'source',
  ]),
  presentation: browserPresentationSchema.optional(),
  vector: browserVectorAttributesSchema.optional(),
  colSpan: z.number().int().min(1).max(1000).optional(),
  rowSpan: z.number().int().min(1).max(65534).optional(),
  text: z.string().max(64000).optional(),
  href: safeUrl.optional(),
  alt: z.string().max(1000).optional(),
  box: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().nonnegative().finite(),
      height: z.number().nonnegative().finite(),
    })
    .optional(),
  listStart: z.number().int().min(-1000000).max(1000000).optional(),
  resourceId: id.optional(),
  /** Internal capture placement only; never an input reference. */
  path: z.array(z.number().int().min(-1)).max(80),
});
export const browserDocumentResourceSchema = z.object({
  id,
  nodeId: id,
  role: z.enum(['image', 'background', 'poster', 'video', 'audio', 'canvas', 'svg']),
  state: z.enum([
    'captured',
    'inline',
    'reference-only',
    'not-loaded',
    'blocked',
    'unsupported',
    'limit-reached',
  ]),
  url: safeUrl.optional(),
  width: z.number().nonnegative().max(100000).optional(),
  height: z.number().nonnegative().max(100000).optional(),
  mimeType: z.literal('image/png').optional(),
  data: z
    .string()
    .max(120000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    .optional(),
});
export const browserRenderedDocumentSchema = z.object({
  presentationVersion: z.literal(1).optional(),
  documentId: id,
  parentDocumentId: id.nullable(),
  ownerNodeId: id.nullable(),
  url: safeUrl,
  title: z.string().max(1000),
  revision: id,
  nodes: z.array(browserDocumentNodeSchema).max(BROWSER_DOCUMENT_LIMITS.nodes),
  resources: z.array(browserDocumentResourceSchema).max(BROWSER_DOCUMENT_LIMITS.assets),
  exclusions: z
    .array(
      z.enum([
        'presentation-omitted',
        'vector-omitted',
        'hidden',
        'active-content',
        'controls',
        'closed-shadow',
        'canvas-pixels',
        'media-unavailable',
        'node-limit',
        'byte-limit',
        'depth-limit',
        'frame-owner-unavailable',
        'frame-unavailable',
      ]),
    )
    .max(20),
  truncated: z.boolean(),
});
export type BrowserRenderedDocument = z.infer<typeof browserRenderedDocumentSchema>;
const omissionReason = z.enum([
  'frame-owner-unavailable',
  'frame-unavailable',
  'document-limit',
  'depth-limit',
  'byte-limit',
]);
export const browserDocumentGraphSchema = z.object({
  protocol: z.literal('rendered-document-v1'),
  buildId: z.literal('trinity-document-v1'),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  documents: z.array(browserRenderedDocumentSchema).min(1).max(BROWSER_DOCUMENT_LIMITS.documents),
  omittedFrames: z.number().int().nonnegative().max(100),
  omissions: z
    .array(z.object({ scopeId: id, parentDocumentId: id.nullable(), reason: omissionReason }))
    .max(100)
    .default([]),
  stability: z.literal('checked-interval'),
  readiness: z.enum(['not-requested', 'ready', 'timed_out']).default('not-requested'),
});
export type BrowserDocumentGraph = z.infer<typeof browserDocumentGraphSchema>;
export const browserDocumentManifestSchema = browserDocumentGraphSchema
  .extend({
    kind: z.literal('browser-document-v1'),
    captureId: id,
    sessionId: z.string().min(1).max(200),
    callId: id,
    bindingId: id,
    tabId: id,
    documentRevision: id,
    browserVersion: z.string().min(1).max(100),
    cliVersion: z.string().min(1).max(100),
    securityMode: z.enum(['trusted-cdp', 'trusted-managed', 'enforced']).optional(),
    runtimeGeneration: id.optional(),
    driverEngine: z.enum(['agent-browser', 'zendriver']).optional(),
    upstreamVersion: z.string().min(1).max(100).optional(),
    hashes: z
      .array(
        z.object({
          documentId: id,
          hash,
          htmlHash: hash,
          htmlBytes: z
            .number()
            .int()
            .positive()
            .max(16 * 1024 * 1024),
          bytes: z.number().int().positive().max(BROWSER_DOCUMENT_LIMITS.documentBytes),
        }),
      )
      .max(BROWSER_DOCUMENT_LIMITS.documents),
    hash,
  })
  .strict();
export type BrowserDocumentManifest = z.infer<typeof browserDocumentManifestSchema>;
export const browserDocumentArguments = [
  z.object({
    operation: z.literal('capture_document'),
    readiness: z
      .object({
        text: z.string().min(1).max(200),
        timeoutMs: z.number().int().min(100).max(10000).default(3000),
      })
      .optional(),
  }),
  z.object({
    operation: z.literal('extract_capture'),
    captureId: id,
    documentId: id.optional(),
    offset: z.number().int().nonnegative().default(0),
  }),
  z.object({
    operation: z.literal('read_capture'),
    captureId: id,
    documentId: id,
    offset: z.number().int().nonnegative().default(0),
  }),
  z.object({
    operation: z.literal('search_capture'),
    captureId: id,
    documentId: id,
    query: z.string().min(1).max(200),
    offset: z.number().int().nonnegative().default(0),
  }),
  z.object({ operation: z.literal('export_capture'), captureId: id }),
] as const;
export const browserDocumentResultSchema = z.object({
  kind: z.literal('browser-document-result-v1'),
  buildId: z.literal('trinity-document-v1'),
  browserVersion: z.string().min(1).max(100),
  operation: z.enum(['capture_document', 'read_capture', 'search_capture', 'export_capture']),
  sessionId: z.string().min(1).max(200),
  callId: id,
  captureId: id,
  hash,
  coverage: z.enum(['captured-within-scope', 'partial']),
  stability: z.literal('checked-interval'),
  documents: z
    .array(
      z.object({
        documentId: id,
        parentDocumentId: id.nullable(),
        hash,
        bytes: z.number().int().positive(),
      }),
    )
    .max(20),
  omittedFrames: z.number().int().nonnegative(),
  omissionReasons: z.array(omissionReason).max(5).default([]),
  presentationOmissions: z
    .array(z.enum(['presentation-omitted', 'vector-omitted']))
    .max(2)
    .optional(),
  resources: z.object({
    captured: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  }),
  /** Unicode ranges of inert HTML, not live action targets or automatic research receipts. */
  ranges: z
    .array(
      z.object({
        documentId: id,
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string().max(8000),
      }),
    )
    .max(10),
  continuation: z.number().int().nonnegative().nullable(),
  conversionOutcome: z.enum(['converted', 'partial']).optional(),
  path: z
    .string()
    .regex(/^browser-capture-[a-f0-9]{32}$/)
    .optional(),
});
export type BrowserDocumentResult = z.infer<typeof browserDocumentResultSchema>;
export const browserDerivationSchema = z.object({
  captureId: id,
  captureHash: hash,
  rootDocumentId: id,
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  converter: z.literal('structural-v1'),
  mappings: z
    .array(z.object({ blockId: id, documentId: id, nodeIds: z.array(id).min(1).max(20000) }))
    .max(1000),
});
