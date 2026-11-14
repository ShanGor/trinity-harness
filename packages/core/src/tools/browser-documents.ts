import { createHash } from 'node:crypto';
import {
  BROWSER_DOCUMENT_LIMITS as LIMITS,
  BROWSER_VECTOR_TAGS,
  browserDocumentGraphSchema,
  browserDocumentManifestSchema,
  browserDocumentResultSchema,
  type BlobStore,
  type BrowserBinding,
  type BrowserCapture,
  type BrowserDocumentGraph,
  type BrowserDocumentManifest,
  type BrowserDocumentResult,
  type BrowserObservation,
  type BrowserRenderedDocument,
  type SessionEvent,
} from '@trinity-harness/contracts';
import { canonicalBrowserJson, suppressedBrowserCalls } from './browser-artifacts.js';
import { BrowserDriverError } from './browser-driver-error.js';

export function documentHash(value: unknown): string {
  return createHash('sha256').update(canonicalBrowserJson(value)).digest('hex');
}
export function documentUri(sessionId: string, captureId: string): string {
  return `blob://browser/${encodeURIComponent(sessionId)}/capture/${captureId}.json`;
}
/** Reservations count failed and interrupted writers as well as successful ones. Orphans stay private. */
export function checkDocumentQuota(events: readonly SessionEvent[]): void {
  const calls = events.filter(
    (e) =>
      e.type === 'tool/call' &&
      e.name === 'browser' &&
      (e.args as { operation?: string } | null)?.operation === 'capture_document',
  );
  let attempts = 0;
  const browserCalls = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === 'message/user' || event.type === 'browser/user_input') attempts = 0;
    if (event.type === 'tool/call' && event.name === 'browser')
      browserCalls.set(event.callId, (event.args as { operation?: unknown } | null)?.operation);
    if (event.type === 'tool/result' && !event.isError) {
      const value = event.value as { kind?: unknown; operation?: unknown; effect?: unknown } | null;
      if (
        value?.kind === 'browser-result-v1' &&
        browserCalls.get(event.callId) === value.operation &&
        ['navigate', 'web_search', 'click', 'fill', 'scroll', 'key'].includes(
          String(value.operation),
        )
      )
        attempts = 0;
    }
    if (
      event.type === 'tool/call' &&
      event.name === 'browser' &&
      (event.args as { operation?: unknown } | null)?.operation === 'capture_document'
    )
      attempts++;
  }
  if (attempts > 2)
    throw new BrowserDriverError(
      'LIMIT_REACHED',
      'Capture recovery quota reached: two attempts already occurred without a new user request or completed live interaction. Use available saved documents or report the specific capture limit.',
    );
  if (calls.length > LIMITS.capturesPerSession)
    throw new BrowserDriverError(
      'LIMIT_REACHED',
      'Document capture session quota reached. Use saved captures.',
    );
}

export function validateDocumentGraph(input: unknown): BrowserDocumentGraph {
  const graph = browserDocumentGraphSchema.parse(input);
  let total = 0,
    resourceCount = 0,
    resourceBytes = 0;
  const docs = new Map<string, BrowserRenderedDocument>();
  for (const doc of graph.documents) {
    const bytes = Buffer.byteLength(canonicalBrowserJson(doc));
    total += bytes;
    if (bytes > LIMITS.documentBytes || total > LIMITS.totalBytes || docs.has(doc.documentId))
      throw new BrowserDriverError('INVALID_OUTPUT');
    if (
      docs.size === 0
        ? doc.parentDocumentId !== null || doc.ownerNodeId !== null
        : !doc.parentDocumentId || !doc.ownerNodeId || !docs.has(doc.parentDocumentId)
    )
      throw new BrowserDriverError('INVALID_OUTPUT');
    let depth = 0,
      parent = doc.parentDocumentId;
    while (parent) {
      depth++;
      parent = docs.get(parent)!.parentDocumentId;
    }
    if (depth > LIMITS.depth) throw new BrowserDriverError('INVALID_OUTPUT');
    if (doc.parentDocumentId) {
      const owner = docs.get(doc.parentDocumentId)!.nodes.find((n) => n.id === doc.ownerNodeId);
      if (
        owner?.tag !== 'iframe' ||
        graph.documents.some(
          (other) =>
            other !== doc &&
            other.parentDocumentId === doc.parentDocumentId &&
            other.ownerNodeId === doc.ownerNodeId,
        )
      )
        throw new BrowserDriverError('INVALID_OUTPUT');
    }
    const nodes = new Set<string>();
    const depths = new Map<string, number>();
    const paths = new Set<string>();
    for (const node of doc.nodes) {
      if (
        nodes.has(node.id) ||
        (node.parentId === null ? nodes.size !== 0 : !nodes.has(node.parentId)) ||
        (node.tag === 'text' && node.text === undefined) ||
        (node.tag !== 'text' && node.text !== undefined)
      )
        throw new BrowserDriverError('INVALID_OUTPUT');
      if (
        node.vector &&
        !BROWSER_VECTOR_TAGS.includes(node.tag as (typeof BROWSER_VECTOR_TAGS)[number])
      )
        throw new BrowserDriverError('INVALID_OUTPUT');
      if (
        node.vector &&
        node.tag !== 'svg' &&
        !doc.nodes.find((parent) => parent.id === node.parentId)?.vector
      )
        throw new BrowserDriverError('INVALID_OUTPUT');
      const pathKey = JSON.stringify(node.path);
      if (paths.has(pathKey)) throw new BrowserDriverError('INVALID_OUTPUT');
      paths.add(pathKey);
      const depth = node.parentId === null ? 0 : depths.get(node.parentId)! + 1;
      if (depth > 80) throw new BrowserDriverError('INVALID_OUTPUT');
      depths.set(node.id, depth);
      nodes.add(node.id);
    }
    const resources = new Set<string>();
    for (const resource of doc.resources) {
      if (
        !nodes.has(resource.nodeId) ||
        (resource.state === 'inline' &&
          (resource.role !== 'svg' ||
            !doc.nodes.find((n) => n.id === resource.nodeId && n.tag === 'svg')?.vector)) ||
        resources.has(resource.id) ||
        (resource.state === 'captured') !== (resource.data !== undefined) ||
        (resource.data && resource.mimeType !== 'image/png')
      )
        throw new BrowserDriverError('INVALID_OUTPUT');
      resources.add(resource.id);
      if (++resourceCount > LIMITS.assets) throw new BrowserDriverError('INVALID_OUTPUT');
      const size = resource.data ? Buffer.byteLength(resource.data.split(',')[1]!, 'base64') : 0;
      if (resource.data) {
        const png = Buffer.from(resource.data.split(',')[1]!, 'base64');
        if (
          png.length < 24 ||
          !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          png.readUInt32BE(16) > 2048 ||
          png.readUInt32BE(20) > 2048
        )
          throw new BrowserDriverError('INVALID_OUTPUT');
      }
      resourceBytes += size;
      if (size > LIMITS.assetBytes || resourceBytes > LIMITS.assetTotalBytes)
        throw new BrowserDriverError('INVALID_OUTPUT');
    }
    if (doc.nodes.some((n) => n.resourceId && !resources.has(n.resourceId)))
      throw new BrowserDriverError('INVALID_OUTPUT');
    docs.set(doc.documentId, doc);
  }
  if (Date.parse(graph.finishedAt) < Date.parse(graph.startedAt))
    throw new BrowserDriverError('INVALID_OUTPUT');
  return graph;
}
export async function persistDocumentGraph(
  graph: BrowserDocumentGraph,
  binding: BrowserBinding,
  sessionId: string,
  callId: string,
  captureId: string,
  blobs: BlobStore,
  signal?: AbortSignal,
): Promise<BrowserDocumentManifest> {
  const checked = validateDocumentGraph(graph);
  const htmlFiles = checked.documents.map((doc) => ({
    documentId: doc.documentId,
    bytes: Buffer.from(documentHtml(doc)),
  }));
  if (
    htmlFiles.some((file) => file.bytes.length > 16 * 1024 * 1024) ||
    htmlFiles.reduce((sum, file) => sum + file.bytes.length, 0) > 64 * 1024 * 1024
  )
    throw new BrowserDriverError('LIMIT_REACHED', 'Inert HTML artifact limit reached.');
  const payload = {
    ...checked,
    kind: 'browser-document-v1' as const,
    captureId,
    sessionId,
    callId,
    bindingId: binding.bindingId,
    tabId: binding.tabId,
    documentRevision: binding.documentRevision,
    browserVersion: binding.browserVersion,
    cliVersion: binding.cliVersion,
    securityMode: binding.securityMode,
    runtimeGeneration: binding.driver?.runtimeGeneration,
    driverEngine: binding.driver?.engine,
    upstreamVersion: binding.driver?.upstreamVersion,
    hashes: checked.documents.map((doc) => ({
      documentId: doc.documentId,
      hash: documentHash(doc),
      htmlHash: createHash('sha256')
        .update(htmlFiles.find((file) => file.documentId === doc.documentId)!.bytes)
        .digest('hex'),
      htmlBytes: htmlFiles.find((file) => file.documentId === doc.documentId)!.bytes.length,
      bytes: Buffer.byteLength(canonicalBrowserJson(doc)),
    })),
  };
  const manifest = browserDocumentManifestSchema.parse({ ...payload, hash: documentHash(payload) });
  const uri = documentUri(sessionId, captureId);
  signal?.throwIfAborted();
  if (await blobs.getMeta(uri)) throw new BrowserDriverError('PERSIST_FAILED');
  try {
    for (const file of htmlFiles) {
      signal?.throwIfAborted();
      const key = `browser/${encodeURIComponent(sessionId)}/capture/${captureId}/${file.documentId}.html`;
      if (await blobs.getMeta('blob://' + key)) throw new BrowserDriverError('PERSIST_FAILED');
      if (blobs.putImmutable) await blobs.putImmutable(key, file.bytes);
      else await blobs.put(key, file.bytes, { mimeType: 'text/html' });
    }
    const bytes = Buffer.from(canonicalBrowserJson(manifest));
    if (blobs.putImmutable) await blobs.putImmutable(uri.slice(7), bytes);
    else await blobs.put(uri.slice(7), bytes, { mimeType: 'application/json' });
  } catch {
    throw new BrowserDriverError('PERSIST_FAILED');
  }
  signal?.throwIfAborted();
  return manifest;
}
/** Only an original committed capture result grants access. Copied/forked receipts do not. */
export function documentCaptureReceipt(
  events: readonly SessionEvent[],
  sessionId: string,
  captureId: string,
): BrowserDocumentResult {
  const calls = new Set<string>();
  let receipt: BrowserDocumentResult | undefined;
  const suppressed = suppressedBrowserCalls(events);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if ('callId' in e && suppressed.has(e.callId)) continue;
    if (
      e.type === 'tool/call' &&
      e.name === 'browser' &&
      (e.args as { operation?: string } | null)?.operation === 'capture_document'
    )
      calls.add(e.callId);
    if (e.type !== 'tool/result' || e.isError || !calls.has(e.callId)) continue;
    const parsed = browserDocumentResultSchema.safeParse(e.value);
    if (
      parsed.success &&
      parsed.data.operation === 'capture_document' &&
      parsed.data.sessionId === sessionId &&
      parsed.data.callId === e.callId &&
      parsed.data.captureId === captureId
    )
      receipt = parsed.data;
  }
  if (!receipt) throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
  return receipt;
}
export async function loadDocumentCapture(
  blobs: BlobStore,
  events: readonly SessionEvent[],
  sessionId: string,
  captureId: string,
  signal?: AbortSignal,
): Promise<BrowserDocumentManifest> {
  const receipt = documentCaptureReceipt(events, sessionId, captureId);
  signal?.throwIfAborted();
  const uri = documentUri(sessionId, captureId);
  const meta = await blobs.getMeta(uri);
  if (!meta || meta.size > LIMITS.totalBytes + 64000)
    throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
  const bytes = await blobs.get(uri);
  signal?.throwIfAborted();
  if (!bytes || bytes.byteLength > LIMITS.totalBytes + 64000)
    throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
  const manifest = browserDocumentManifestSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  const { hash, ...payload } = manifest;
  if (
    manifest.sessionId !== sessionId ||
    manifest.captureId !== captureId ||
    manifest.callId !== receipt.callId ||
    hash !== receipt.hash ||
    documentHash(payload) !== hash
  )
    throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
  validateDocumentGraph(manifest);
  if (
    manifest.hashes.length !== manifest.documents.length ||
    manifest.documents.some((doc, i) => {
      const entry = manifest.hashes[i]!;
      return (
        entry.documentId !== doc.documentId ||
        entry.hash !== documentHash(doc) ||
        entry.bytes !== Buffer.byteLength(canonicalBrowserJson(doc))
      );
    })
  )
    throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
  let htmlTotal = 0;
  for (const entry of manifest.hashes) {
    htmlTotal += entry.htmlBytes;
    if (htmlTotal > 64 * 1024 * 1024) throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
    const htmlUri = `blob://browser/${encodeURIComponent(sessionId)}/capture/${captureId}/${entry.documentId}.html`;
    const meta = await blobs.getMeta(htmlUri);
    if (!meta || meta.size !== entry.htmlBytes)
      throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
    signal?.throwIfAborted();
    const bytes = await blobs.get(htmlUri);
    signal?.throwIfAborted();
    if (
      !bytes ||
      bytes.length !== entry.htmlBytes ||
      createHash('sha256').update(bytes).digest('hex') !== entry.htmlHash ||
      createHash('sha256')
        .update(
          documentHtml(manifest.documents.find((doc) => doc.documentId === entry.documentId)!),
        )
        .digest('hex') !== entry.htmlHash
    )
      throw new BrowserDriverError('ARTIFACT_UNAVAILABLE');
  }
  return manifest;
}
const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Values have passed the closed presentation/vector schemas before rendering. */
function presentationAttributes(node: BrowserRenderedDocument['nodes'][number]): string {
  const style = Object.entries(node.presentation ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return (
    (style ? ` style="${escape(style)}"` : '') +
    Object.entries(node.vector ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => ` ${name}="${escape(value)}"`)
      .join('') +
    (node.vector && node.tag === 'svg' ? ' xmlns="http://www.w3.org/2000/svg"' : '') +
    (node.colSpan ? ` colspan="${node.colSpan}"` : '') +
    (node.rowSpan ? ` rowspan="${node.rowSpan}"` : '')
  );
}
function vectorTag(node: BrowserRenderedDocument['nodes'][number]): string | undefined {
  return node.vector ? (node.tag === 'svg-text' ? 'text' : node.tag) : undefined;
}
/** HTML is generated exclusively from the policy-filtered typed tree. No parser, scripts or network. */
export function documentHtml(doc: BrowserRenderedDocument): string {
  const children = new Map<string | null, typeof doc.nodes>();
  for (const n of doc.nodes) {
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const render = (parent: string | null): string =>
    (children.get(parent) ?? [])
      .map((n) => {
        if (n.tag === 'text') return escape(n.text!);
        const tag =
          vectorTag(n) ??
          (['iframe', 'shadow', 'svg', 'canvas', 'source', 'video', 'audio'].includes(n.tag)
            ? 'div'
            : n.tag);
        const resource = doc.resources.find((r) => r.id === n.resourceId);
        const src = resource?.data ? ` src="${escape(resource.data)}"` : '';
        const attributes =
          presentationAttributes(n) +
          (n.alt ? ` alt="${escape(n.alt)}"` : '') +
          ` data-capture-node="${n.id}"` +
          (n.href ? ` data-source-href="${escape(n.href)}"` : '') +
          (n.tag === 'shadow' ? ' data-open-shadow="true"' : '');
        return `<${tag}${attributes}${src}>${render(n.id)}${['img', 'br', 'hr', 'source'].includes(tag) ? '' : `</${tag}>`}`;
      })
      .join('');
  return (
    (doc.presentationVersion
      ? "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\">"
      : '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; form-action \'none\'; base-uri \'none\'">') +
    render(null)
  );
}

/** Offline converter input: owned frames replace their owner nodes in document order.
 * Only safe captured structure is used. Remote media never becomes a loadable src.
 * Original URLs and immutable source hashes stay in the manifest; exported media uses local paths.
 */
export function documentConversionHtml(
  manifest: BrowserDocumentManifest,
  documentId?: string,
): string {
  const root =
    documentId === undefined
      ? manifest.documents[0]
      : manifest.documents.find((doc) => doc.documentId === documentId);
  if (!root) throw new BrowserDriverError('INVALID_ARGUMENTS');
  const localMedia = new Map<string, string>();
  for (const doc of manifest.documents)
    for (const resource of doc.resources)
      if (resource.url && resource.data)
        localMedia.set(resource.url, 'media/' + documentHash(resource.data) + '.png');
  const renderDocument = (doc: BrowserRenderedDocument): string => {
    const children = new Map<string | null, typeof doc.nodes>();
    for (const node of doc.nodes) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const render = (parentId: string | null): string =>
      (children.get(parentId) ?? [])
        .map((node) => {
          if (node.tag === 'text') return escape(node.text!);
          const identity = ` data-capture-document="${doc.documentId}" data-capture-node="${node.id}"`;
          if (node.tag === 'iframe') {
            const child = manifest.documents.find(
              (candidate) =>
                candidate.parentDocumentId === doc.documentId && candidate.ownerNodeId === node.id,
            );
            return `<section${identity}>${child ? (documentId === undefined ? renderDocument(child) : `<a href="${child.documentId}.html">Captured embedded document</a>`) : '<p>[Embedded document unavailable]</p>'}</section>`;
          }
          const tag =
            vectorTag(node) ??
            (['html', 'body', 'shadow', 'svg', 'canvas', 'source', 'video', 'audio'].includes(
              node.tag,
            )
              ? 'div'
              : node.tag);
          const asset = doc.resources.find((resource) => resource.id === node.resourceId);
          if (tag === 'img' && !asset?.data)
            return `<span${identity}>${escape(node.alt ?? '')} [Image unavailable offline]</span>`;
          const attrs =
            identity +
            presentationAttributes(node) +
            (node.href ? ` href="${escape(localMedia.get(node.href) ?? node.href)}"` : '') +
            (node.alt ? ` alt="${escape(node.alt)}"` : '') +
            (node.tag === 'ol' && node.listStart !== undefined
              ? ` start="${node.listStart}"`
              : '') +
            (tag === 'img' && asset?.data ? ` src="media/${documentHash(asset.data)}.png"` : '');
          return `<${tag}${attrs}>${render(node.id)}${['img', 'br', 'hr'].includes(tag) ? '' : `</${tag}>`}`;
        })
        .join('');
    return render(null);
  };
  return (
    (manifest.documents.some((doc) => doc.presentationVersion)
      ? "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\">"
      : "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self'; form-action 'none'; base-uri 'none'\">") +
    renderDocument(root)
  );
}

export function documentResult(
  manifest: BrowserDocumentManifest,
  operation: BrowserDocumentResult['operation'],
  callId: string,
): BrowserDocumentResult {
  const resources = manifest.documents.flatMap((d) => d.resources);
  return {
    kind: 'browser-document-result-v1',
    buildId: manifest.buildId,
    browserVersion: manifest.browserVersion,
    operation,
    sessionId: manifest.sessionId,
    callId,
    captureId: manifest.captureId,
    hash: manifest.hash,
    coverage:
      manifest.readiness === 'timed_out' ||
      manifest.omittedFrames ||
      manifest.documents.some(
        (d) =>
          d.truncated ||
          d.exclusions.some((e) => e === 'presentation-omitted' || e === 'vector-omitted'),
      )
        ? 'partial'
        : 'captured-within-scope',
    stability: manifest.stability,
    omittedFrames: manifest.omittedFrames,
    omissionReasons: [...new Set(manifest.omissions.map((o) => o.reason))],
    documents: manifest.hashes.map((h) => ({
      documentId: h.documentId,
      hash: h.hash,
      bytes: h.bytes,
      parentDocumentId: manifest.documents.find((d) => d.documentId === h.documentId)!
        .parentDocumentId,
    })),
    ...(manifest.documents.some((d) => d.presentationVersion)
      ? {
          presentationOmissions: [
            ...new Set(
              manifest.documents.flatMap((d) =>
                d.exclusions.filter(
                  (e): e is 'presentation-omitted' | 'vector-omitted' =>
                    e === 'presentation-omitted' || e === 'vector-omitted',
                ),
              ),
            ),
          ],
        }
      : {}),
    resources: {
      captured: resources.filter((r) => r.state === 'captured' || r.state === 'inline').length,
      unavailable: resources.filter((r) => r.state !== 'captured' && r.state !== 'inline').length,
    },
    ranges: [],
    continuation: null,
  };
}
export function readDocumentCapture(
  manifest: BrowserDocumentManifest,
  documentId: string,
  offset: number,
  query?: string,
): { ranges: BrowserDocumentResult['ranges']; continuation: number | null } {
  const doc = manifest.documents.find((d) => d.documentId === documentId);
  if (!doc) throw new BrowserDriverError('INVALID_ARGUMENTS');
  const points = Array.from(documentHtml(doc));
  if (offset > points.length) throw new BrowserDriverError('INVALID_ARGUMENTS');
  let start = offset;
  if (query !== undefined) {
    const tail = points.slice(offset).join('');
    const found = tail.indexOf(query);
    if (found < 0) return { ranges: [], continuation: null };
    start += Array.from(tail.slice(0, found)).length;
  }
  let end = Math.min(
    points.length,
    start + (query === undefined ? 1500 : Math.max(300, Array.from(query).length)),
  );
  while (Buffer.byteLength(JSON.stringify(points.slice(start, end).join(''))) > 2200) end--;
  const text = points.slice(start, end).join('');
  return {
    ranges: [{ documentId, start, end, text }],
    continuation: end < points.length ? end : null,
  };
}

/** Conversion is paged independently of model delivery. Saved HTML never needs recapture. */
export function convertDocumentCapture(
  manifest: BrowserDocumentManifest,
  documentId?: string,
  offset = 0,
): BrowserCapture & Pick<BrowserObservation, 'derivation'> {
  const selected = documentId
    ? manifest.documents.find((d) => d.documentId === documentId)
    : manifest.documents[0];
  if (!selected || !Number.isSafeInteger(offset) || offset < 0)
    throw new BrowserDriverError('INVALID_ARGUMENTS');
  type Block = BrowserCapture['blocks'][number];
  type Candidate = {
    block: Omit<Block, 'id' | 'sectionId'>;
    documentId: string;
    nodeIds: string[];
  };
  let representationLimited = false;
  function* candidates(doc: BrowserRenderedDocument): Generator<Candidate> {
    const children = new Map<string | null, typeof doc.nodes>();
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    for (const node of doc.nodes) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
    const subtree = (id: string, omitLists = false): typeof doc.nodes =>
      (children.get(id) ?? []).flatMap((n) =>
        omitLists && ['ul', 'ol'].includes(n.tag) ? [] : [n, ...subtree(n.id, omitLists)],
      );
    const rawText = (nodes: typeof doc.nodes): string =>
      nodes.map((n) => (n.tag === 'text' ? n.text! : n.tag === 'br' ? '\n' : '')).join('');
    function* walk(parent: string | null): Generator<Candidate> {
      for (const node of children.get(parent) ?? []) {
        if (node.tag === 'iframe') {
          const child = manifest.documents.find(
            (d) => d.parentDocumentId === doc.documentId && d.ownerNodeId === node.id,
          );
          if (child) yield* candidates(child);
          continue;
        }
        if (node.tag === 'img') {
          const asset = doc.resources.find((r) => r.id === node.resourceId);
          if (asset?.url)
            yield {
              documentId: doc.documentId,
              nodeIds: [node.id],
              block: {
                kind: 'paragraph',
                text: node.alt || 'Image',
                links: [],
                image: {
                  url: asset.url,
                  alt: node.alt || '',
                  ...(asset.data ? { data: asset.data } : {}),
                },
              },
            };
          continue;
        }
        const descendants = subtree(node.id, node.tag === 'li');
        const semantic =
          (/^h[1-6]$/.test(node.tag) || ['p', 'li', 'pre', 'table'].includes(node.tag)) &&
          !descendants.some((n) => n.tag === 'iframe' || n.tag === 'img');
        if (!semantic && node.tag !== 'text') {
          yield* walk(node.id);
          continue;
        }
        const nodes = semantic ? [node, ...descendants] : [node];
        const links = nodes
          .filter((n) => n.href)
          .slice(0, 20)
          .map((n) => ({ title: n.href!.slice(0, 200), url: n.href! }));
        if (node.tag === 'text') {
          for (let p = node.parentId; p; p = byId.get(p)?.parentId ?? null) {
            const ancestor = byId.get(p);
            if (ancestor?.href) {
              links.push({ title: ancestor.href.slice(0, 200), url: ancestor.href });
              break;
            }
          }
        }
        if (node.tag === 'table') {
          let rows: NonNullable<Block['rows']> = [],
            chars = 0;
          let rowNodeIds: string[] = [node.id];
          const allRows = nodes.filter((n) => n.tag === 'tr');
          for (const row of allRows) {
            const cells = (children.get(row.id) ?? []).filter((n) => ['td', 'th'].includes(n.tag));
            if (cells.length > 40) representationLimited = true;
            const values = cells.slice(0, 40).map((cell) => {
              const text = rawText(subtree(cell.id)).trim();
              if (text.length > 10000) representationLimited = true;
              return { text: Array.from(text).slice(0, 10000).join(''), header: cell.tag === 'th' };
            });
            const size = values.reduce((n, c) => n + c.text.length + 3, 0);
            if (size > 60000) {
              representationLimited = true;
              for (const cell of values) cell.text = Array.from(cell.text).slice(0, 1000).join('');
            }
            const boundedSize = values.reduce((n, c) => n + c.text.length + 3, 0);
            if (rows.length && (rows.length >= 100 || chars + boundedSize > 60000)) {
              yield {
                documentId: doc.documentId,
                nodeIds: rowNodeIds,
                block: {
                  kind: 'table',
                  text: rows.map((r) => r.map((c) => c.text).join(' | ')).join('\n'),
                  rows,
                  links,
                },
              };
              rows = [];
              chars = 0;
              rowNodeIds = [node.id];
            }
            rowNodeIds.push(row.id, ...subtree(row.id).map((n) => n.id));
            rows.push(values);
            chars += boundedSize;
          }
          if (rows.length)
            yield {
              documentId: doc.documentId,
              nodeIds: rowNodeIds,
              block: {
                kind: 'table',
                text: rows.map((r) => r.map((c) => c.text).join(' | ')).join('\n'),
                rows,
                links,
              },
            };
        } else {
          const raw = rawText(nodes),
            text = node.tag === 'pre' ? raw : raw.replace(/\s+/g, ' ').trim();
          const kind: Block['kind'] = /^h[1-6]$/.test(node.tag)
            ? 'heading'
            : node.tag === 'li'
              ? 'list_item'
              : node.tag === 'pre'
                ? 'code'
                : 'paragraph';
          let listDepth = 0,
            ordinal: number | undefined;
          if (kind === 'list_item') {
            let first = true;
            for (let p = node.parentId; p; p = byId.get(p)?.parentId ?? null) {
              const ancestor = byId.get(p)!;
              if (['ol', 'ul'].includes(ancestor.tag)) {
                if (first && ancestor.tag === 'ol')
                  ordinal =
                    (ancestor.listStart ?? 1) +
                    (children.get(p) ?? [])
                      .filter((n) => n.tag === 'li')
                      .findIndex((n) => n.id === node.id);
                listDepth++;
                first = false;
              }
            }
          }
          const points = Array.from(text);
          for (let start = 0; start < points.length; start += 16000)
            yield {
              documentId: doc.documentId,
              nodeIds: nodes.map((n) => n.id),
              block: {
                kind,
                text: points.slice(start, start + 16000).join(''),
                links,
                ...(kind === 'heading' ? { level: Number(node.tag[1]) } : {}),
                ...(kind === 'list_item'
                  ? {
                      listDepth: Math.max(0, Math.min(40, listDepth - 1)),
                      ...(ordinal !== undefined ? { ordinal } : {}),
                    }
                  : {}),
              },
            };
        }
        if (node.tag === 'li') {
          function* lists(parentId: string): Generator<Candidate> {
            for (const child of children.get(parentId) ?? []) {
              if (['ul', 'ol'].includes(child.tag)) yield* walk(child.id);
              else yield* lists(child.id);
            }
          }
          yield* lists(node.id);
        }
      }
    }
    yield* walk(null);
  }
  const blocks: Block[] = [],
    mappings: NonNullable<BrowserObservation['derivation']>['mappings'] = [];
  let index = 0,
    bytes = 0,
    nextOffset: number | null = null;
  for (const candidate of candidates(selected)) {
    if (index++ < offset) continue;
    const block = { ...candidate.block, id: 'b' + blocks.length, sectionId: null };
    const mapping = {
      blockId: block.id,
      documentId: candidate.documentId,
      nodeIds: candidate.nodeIds,
    };
    const size = Buffer.byteLength(canonicalBrowserJson({ block, mapping }));
    if (blocks.length >= 1000 || bytes + size > 175000) {
      nextOffset = index - 1;
      break;
    }
    blocks.push(block);
    mappings.push(mapping);
    bytes += size;
  }
  if (offset > index || (nextOffset === offset && blocks.length === 0))
    throw new BrowserDriverError(
      'LIMIT_REACHED',
      'Conversion scope cannot fit a semantic artifact. Read the saved HTML with read_capture.',
    );
  let sectionId: string | null = null;
  for (const block of blocks) {
    if (block.kind === 'heading') sectionId = block.id;
    block.sectionId = sectionId;
  }
  const partial =
    nextOffset !== null ||
    representationLimited ||
    manifest.readiness === 'timed_out' ||
    manifest.omittedFrames > 0 ||
    manifest.documents.some((d) => d.truncated);
  return {
    schemaVersion: 1,
    extractorVersion: 'rendered-v1',
    url: selected.url,
    title: selected.title,
    publishedAt: null,
    readiness: partial ? 'partial' : 'ready',
    representation: 'documentation',
    scope: 'saved-rendered-documents',
    exclusions: [
      'policy-filtered structure',
      'closed shadow roots',
      'canvas text',
      'unmounted content',
      'media coverage independent',
      ...(nextOffset !== null
        ? ['more converted blocks: use extract_capture with capture.nextOffset']
        : []),
      ...(representationLimited
        ? ['table cell/column conversion limit; original saved HTML retained']
        : []),
    ],
    blocks,
    captureTruncated: nextOffset !== null || representationLimited,
    derivation: {
      captureId: manifest.captureId,
      captureHash: manifest.hash,
      rootDocumentId: selected.documentId,
      offset,
      nextOffset,
      converter: 'structural-v1',
      mappings,
    },
  };
}
