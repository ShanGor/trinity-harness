import { PNG } from 'pngjs';
import {
  BROWSER_LIMITS,
  browserPreviewSchema,
  browserSurfaceSchema,
  browserUrlSchema,
  type BrowserAccessPort,
  type BrowserDriverPort,
  type BrowserPreview,
  type ToolContext,
  type SessionStore,
} from '@trinity-harness/contracts';
import { interactionFromSurface } from './browser-interactions.js';
import { BrowserDriverError } from './browser-driver-error.js';
import { browserDeliveries } from './browser-artifacts.js';

/** Existing CDP can be viewed only after a successful committed owned-tab operation. */
export async function captureCommittedCdpPreview(
  store: SessionStore,
  access: BrowserAccessPort,
  driver: BrowserDriverPort,
  ctx: ToolContext,
  now: () => Date,
): Promise<BrowserPreview> {
  const deliveries = browserDeliveries(await store.load(ctx.sessionId), ctx.sessionId);
  const source = deliveries.findLast(
    (delivery) => delivery.result.securityMode === 'trusted-cdp' && !delivery.result.saved,
  )?.result;
  if (!source || !/^[a-f0-9]{32}$/.test(source.bindingId)) return { state: 'unavailable' };
  const hex = source.bindingId;
  const generation = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  return captureBrowserPreview(
    {
      authorize: async (...args) => {
        const binding = await access.authorize(...args);
        if (binding.bindingId !== source.bindingId || binding.tabId !== source.tabId)
          throw new BrowserDriverError('NOT_AUTHORIZED');
        return binding;
      },
    },
    driver,
    ctx,
    generation,
    now,
  );
}

/** User-only capture: no artifacts, exposure receipts, model history or input refs. */
export async function captureBrowserPreview(
  access: BrowserAccessPort,
  driver: BrowserDriverPort,
  ctx: ToolContext,
  generation: string,
  now: () => Date,
): Promise<BrowserPreview> {
  try {
    const binding = await access.authorize(ctx.sessionId, 'screenshot', undefined, ctx.signal);
    await driver.verify(binding, ctx);
    // An empty managed tab can be viewed/handed back without becoming source evidence.
    const url =
      binding.securityMode === 'trusted-managed' && binding.observedUrl === 'about:blank'
        ? 'about:blank'
        : browserUrlSchema.parse(binding.observedUrl);
    if (
      Array.from(new URL(url).searchParams.keys()).some((key) =>
        /token|secret|password|api[-_]?key|authorization|^code$/i.test(key),
      )
    )
      return { state: 'privacy_blocked' };
    const surface = browserSurfaceSchema.parse(
      await driver.surface(binding, 'all', undefined, ctx),
    );
    if (surface.privacyDenied) return { state: 'privacy_blocked' };
    const { width, height } = surface.context;
    if (width > BROWSER_LIMITS.imageDimension || height > BROWSER_LIMITS.imageDimension)
      return { state: 'unavailable' };
    if ((await driver.paint(binding, ctx)) !== 'ready') return { state: 'busy' };
    const bytes = Buffer.from(await driver.screenshot(binding, ctx));
    if (
      bytes.length > BROWSER_LIMITS.image ||
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== width ||
      bytes.readUInt32BE(20) !== height
    )
      return { state: 'unavailable' };
    PNG.sync.read(bytes); // Decode only after bounding bytes and dimensions.
    const after = browserSurfaceSchema.parse(await driver.surface(binding, 'all', undefined, ctx));
    if (after.privacyDenied) return { state: 'privacy_blocked' };
    const current = await access.authorize(ctx.sessionId, 'screenshot', undefined, ctx.signal);
    if (
      current.bindingId !== binding.bindingId ||
      current.tabId !== binding.tabId ||
      current.documentRevision !== binding.documentRevision ||
      current.observedUrl !== url ||
      interactionFromSurface(after).fingerprint !== interactionFromSurface(surface).fingerprint
    )
      return { state: 'busy' };
    ctx.signal?.throwIfAborted();
    return browserPreviewSchema.parse({
      state: 'frame',
      generation,
      capturedAt: now().toISOString(),
      securityMode: binding.securityMode,
      width,
      height,
      png: bytes.toString('base64'),
    });
  } catch (error) {
    ctx.signal?.throwIfAborted();
    return {
      state:
        error instanceof BrowserDriverError && error.code === 'PRIVACY_DENIED'
          ? 'privacy_blocked'
          : 'unavailable',
    };
  }
}
