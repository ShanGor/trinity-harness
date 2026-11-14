import { z } from 'zod';
import { browserUrlSchema, type BrowserCapture } from '@trinity-harness/contracts';
import { BrowserDriverError, parseBrowserCapture } from './browser-driver-error.js';
import { browserExtractor } from './browser-extractor.js';
import { browserSurfaceScript } from './browser-interactions.js';
import { zendriverStructured, type ZendriverClient } from './zendriver-mcp.js';

const framesSchema = z.object({
  frames: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        url: z.string().max(2000),
        parent_id: z.string().nullable(),
        is_main: z.boolean(),
      }),
    )
    .max(100),
});
/** Fixed embed discovery: URLs are private adapter metadata, never action targets. */
const embeds = `(()=>{const out=[];const roots=[document];for(let i=0;i<roots.length&&i<100;i++){let count=0;for(const el of roots[i].querySelectorAll('*')){if(++count>20000)break;if(el.shadowRoot)roots.push(el.shadowRoot);if(!['IFRAME','FRAME'].includes(el.tagName))continue;let visible=el.getClientRects().length>0;for(let p=el;p;p=p.parentElement||p.getRootNode()?.host){const s=getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.opacity==='0')visible=false;}if(visible&&out.length<20)out.push(el.hasAttribute('srcdoc')?'about:srcdoc':el.src);}}return out;})()`;

/** Reads only visible descendants of the owned main frame, with no navigation or HTTP fallback. */
export async function captureEmbeddedFrames(
  client: ZendriverClient,
  capture: BrowserCapture,
  mode: 'article' | 'documentation',
  signal?: AbortSignal,
  privacyOnly = false,
): Promise<BrowserCapture> {
  const evaluate = async (expression: string, frameId?: string): Promise<unknown> =>
    z
      .object({ value: z.unknown() })
      .parse(
        zendriverStructured(
          await client.call(
            'browser_evaluate',
            { expression, ...(frameId ? { frame_id: frameId } : {}) },
            signal,
          ),
        ),
      ).value;
  const frames = framesSchema.parse(
    zendriverStructured(await client.call('browser_frame_list', {}, signal)),
  ).frames;
  const main = frames.find((f) => f.is_main);
  if (!main) throw new BrowserDriverError('INVALID_OUTPUT');
  const queue = [{ id: main.id, depth: 0 }];
  let bytes = Buffer.byteLength(JSON.stringify(capture)),
    count = 0;
  while (queue.length) {
    const parent = queue.shift()!;
    if (parent.depth >= 3) {
      if (frames.some((f) => f.parent_id === parent.id))
        throw new BrowserDriverError(
          'LIMIT_REACHED',
          'Embedded privacy inspection depth exceeded.',
        );
      continue;
    }
    const visible = z
      .array(z.string().max(2000))
      .max(20)
      .parse(await evaluate(embeds, parent.id === main.id ? undefined : parent.id));
    for (const frame of frames.filter((f) => f.parent_id === parent.id && !f.is_main)) {
      if (
        !visible.includes(frame.url) ||
        frames.filter((f) => f.parent_id === parent.id && f.url === frame.url).length !== 1
      )
        continue;
      if (++count > 20) {
        throw new BrowserDriverError(
          'LIMIT_REACHED',
          'Embedded privacy inspection count exceeded.',
        );
      }
      if (frame.url !== 'about:srcdoc') {
        const url = browserUrlSchema.safeParse(frame.url);
        if (!url.success) continue;
        if (
          Array.from(new URL(url.data).searchParams.keys()).some((k) =>
            /token|secret|password|api[-_]?key|authorization|^code$/i.test(k),
          )
        )
          throw new BrowserDriverError('PRIVACY_DENIED');
      }
      // Surface and extractor both check protected controls; no scope bypass.
      const surface = z
        .object({ privacyDenied: z.boolean() })
        .parse(await evaluate(browserSurfaceScript('all'), frame.id));
      if (surface.privacyDenied) throw new BrowserDriverError('PRIVACY_DENIED');
      const value = await evaluate(browserExtractor(mode, undefined, true), frame.id);
      if (z.object({ privacyDenied: z.literal(true) }).safeParse(value).success)
        throw new BrowserDriverError('PRIVACY_DENIED');
      const child = parseBrowserCapture({
        ...z.record(z.string(), z.unknown()).parse(value),
        url: frame.url === 'about:srcdoc' ? capture.url : frame.url,
      });
      // Same-origin descendants already present in the main semantic capture.
      // Select cross-origin or opaque documents only, avoiding duplicate text.
      const opaque = frame.url === 'about:srcdoc';
      if (!opaque && z.object({ url: z.string() }).parse(value).url !== frame.url)
        throw new BrowserDriverError('STALE_TARGET');
      if (!privacyOnly) {
        for (const block of child.blocks) {
          const size = Buffer.byteLength(JSON.stringify(block));
          if (bytes + size > 180000 || capture.blocks.length >= 1000) {
            capture.captureTruncated = true;
            break;
          }
          bytes += size;
          capture.blocks.push({ ...block, id: `b${capture.blocks.length}`, sectionId: null });
        }
        if (capture.extraction) {
          capture.extraction.embeddedFrames = (capture.extraction.embeddedFrames ?? 0) + 1;
          capture.extraction.unavailableFrames = Math.max(
            0,
            (capture.extraction.unavailableFrames ?? 0) - 1,
          );
        }
        capture.captureTruncated ||= child.captureTruncated;
      }
      queue.push({ id: frame.id, depth: parent.depth + 1 });
    }
  }
  const after = framesSchema.parse(
    zendriverStructured(await client.call('browser_frame_list', {}, signal)),
  ).frames;
  if (
    JSON.stringify(after.map((f) => [f.id, f.url, f.parent_id])) !==
    JSON.stringify(frames.map((f) => [f.id, f.url, f.parent_id]))
  )
    throw new BrowserDriverError('STALE_TARGET');
  if (!privacyOnly && capture.blocks.some((b) => b.kind !== 'heading') && capture.extraction) {
    capture.extraction.status = 'text-captured';
    capture.readiness = (capture.extraction.unavailableFrames ?? 0) > 0 ? 'partial' : 'ready';
  }
  return capture;
}
