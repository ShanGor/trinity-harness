import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PNG } from 'pngjs';
import {
  BROWSER_LIMITS,
  browserCaptureSchema,
  browserSurfaceSchema,
  browserDriverActionSchema,
  browserDriverStateSchema,
  browserUrlSchema,
  type BrowserDriverPort,
  type BrowserAccessPort,
  type BrowserBinding,
  type BrowserDriverState,
  type BrowserSurface,
  type BrowserCapture,
  type BrowserHumanCapture,
  type BrowserHumanAction,
  type BrowserFrameTarget,
  type BrowserKeyboardTarget,
  type BrowserHumanInputResult,
  type ToolContext,
} from '@trinity-harness/contracts';
import { browserExtractor } from './browser-extractor.js';
import {
  browserSurfaceScript,
  browserTargetSelector,
  browserReadinessScript,
  interactionFromSurface,
} from './browser-interactions.js';
import { captureBrowserPreview } from './browser-preview.js';
import {
  browserPointScript,
  browserPaintScript,
  browserStateScript,
  browserFocusScript,
} from './browser-driver-scripts.js';
import { BrowserDriverError } from './browser-driver-error.js';
import { ZENDRIVER_VERSION, zendriverStructured, type ZendriverClient } from './zendriver-mcp.js';

const ack = z.object({ ok: z.literal(true) });
/** Chrome's internal network-error document (failed navigation, dead proxy…). */
const CHROME_ERROR_PAGE_URL = 'chrome-error://chromewebdata/';
/** One instance is bound to one supervisor-owned MCP connection and generation. */
export class ZendriverBrowserDriver implements BrowserDriverPort, BrowserAccessPort {
  private readonly focusKey = `__trinity_focus_${randomUUID()}`;
  constructor(
    private readonly client: ZendriverClient,
    private readonly sessionId: string,
    private readonly generation: string,
    private readonly authorizeSession: (
      sessionId: string,
      signal?: AbortSignal,
    ) => Promise<boolean>,
  ) {}

  private async evaluate(script: string, signal?: AbortSignal): Promise<unknown> {
    return z
      .object({ value: z.unknown() })
      .parse(
        zendriverStructured(
          await this.client.call('browser_evaluate', { expression: script }, signal),
        ),
      ).value;
  }
  private async humanBinding(signal?: AbortSignal): Promise<BrowserBinding> {
    if (!(await this.authorizeSession(this.sessionId, signal)))
      throw new BrowserDriverError('NOT_AUTHORIZED');
    const state = await this.inspect(signal);
    return this.binding(state);
  }
  private async humanFocus(signal?: AbortSignal): Promise<{ revision: string; focused: boolean }> {
    return z
      .object({ revision: z.string().min(1).max(200), focused: z.boolean() })
      .parse(await this.evaluate(browserFocusScript(this.focusKey, randomUUID()), signal));
  }
  private binding(state: BrowserDriverState): BrowserBinding {
    return {
      bindingId: createHash('sha256').update(`${this.sessionId}\n${this.generation}`).digest('hex'),
      tabId: state.tabId,
      documentRevision: state.documentRevision,
      cliVersion: `zendriver-${ZENDRIVER_VERSION}`,
      browserVersion: state.browserVersion,
      cliSession: `managed-${this.generation}`,
      observedUrl: state.url,
      securityMode: 'trusted-managed',
      driver: {
        engine: 'zendriver',
        adapterVersion: 1,
        upstreamVersion: ZENDRIVER_VERSION,
        runtimeGeneration: this.generation,
      },
    };
  }
  async humanFrame(
    privateView: boolean,
    ctx: ToolContext,
    now: () => Date = () => new Date(),
  ): Promise<BrowserHumanCapture> {
    if (!privateView)
      return { preview: await captureBrowserPreview(this, this, ctx, this.generation, now) };
    const binding = await this.humanBinding(ctx.signal);
    const focusBefore = await this.humanFocus(ctx.signal);
    const before = await this.surface(binding, 'all', undefined, ctx);
    const { width, height } = before.context;
    if (width > BROWSER_LIMITS.imageDimension || height > BROWSER_LIMITS.imageDimension)
      return { preview: { state: 'unavailable' } };
    if ((await this.paint(binding, ctx)) !== 'ready') return { preview: { state: 'busy' } };
    const bytes = Buffer.from(await this.screenshot(binding, ctx));
    if (
      bytes.length < 24 ||
      bytes.length > BROWSER_LIMITS.image ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== width ||
      bytes.readUInt32BE(20) !== height
    )
      return { preview: { state: 'unavailable' } };
    PNG.sync.read(bytes);
    const current = await this.humanBinding(ctx.signal);
    const after = await this.surface(current, 'all', undefined, ctx);
    const focusAfter = await this.humanFocus(ctx.signal);
    const fingerprint = interactionFromSurface(before).fingerprint;
    if (
      binding.tabId !== current.tabId ||
      binding.documentRevision !== current.documentRevision ||
      focusBefore.revision !== focusAfter.revision ||
      fingerprint !== interactionFromSurface(after).fingerprint
    )
      return { preview: { state: 'busy' } };
    const capturedAt = now().toISOString();
    return {
      preview: {
        state: 'frame',
        generation: this.generation,
        capturedAt,
        securityMode: 'trusted-managed',
        width,
        height,
        png: bytes.toString('base64'),
      },
      target: {
        tabId: binding.tabId,
        documentRevision: binding.documentRevision,
        fingerprint,
        focusRevision: focusAfter.revision,
        width,
        height,
        capturedAt,
      },
    };
  }
  async humanInput(
    action: BrowserHumanAction,
    target: BrowserFrameTarget | BrowserKeyboardTarget,
    ctx: ToolContext,
  ): Promise<BrowserHumanInputResult> {
    const binding = await this.humanBinding(ctx.signal);
    if (binding.tabId !== target.tabId || binding.documentRevision !== target.documentRevision)
      return { effect: 'none' };
    const keyboard = !('frameId' in target);
    if (keyboard && action.type !== 'text' && action.type !== 'key') return { effect: 'none' };
    if (!keyboard) {
      const surface = await this.surface(binding, 'all', undefined, ctx);
      if (interactionFromSurface(surface).fingerprint !== target.fingerprint)
        return { effect: 'none' };
    }
    const before = await this.humanFocus(ctx.signal);
    if (
      (action.type === 'text' || action.type === 'key') &&
      target.focusRevision !== undefined &&
      before.revision !== target.focusRevision
    )
      return { effect: 'none' };
    const inside = (p: { x: number; y: number }): boolean =>
      'frameId' in target && p.x < target.width && p.y < target.height;
    if (
      (action.type === 'click' && !inside(action.point)) ||
      (action.type === 'drag' && (!inside(action.from) || !inside(action.to)))
    )
      return { effect: 'none' };
    if (action.type === 'navigate') {
      await this.navigate(binding, action.url, ctx);
      return { effect: 'applied' };
    }
    if (action.type === 'click' || action.type === 'drag') {
      const args =
        action.type === 'click'
          ? {
              action: 'click',
              ...action.point,
              button: action.button,
              click_count: action.count,
              modifiers: action.modifiers,
            }
          : { action: 'drag', ...action.from, to_x: action.to.x, to_y: action.to.y, steps: 12 };
      ack.parse(
        zendriverStructured(
          await this.client.call('browser_mouse', { ...args, return_snapshot: false }, ctx.signal),
        ),
      );
    } else if (action.type === 'scroll') {
      await this.client.call(
        'browser_scroll',
        { dx: action.dx, dy: action.dy, return_snapshot: false },
        ctx.signal,
      );
    } else {
      const step =
        action.type === 'text'
          ? { text: action.text }
          : { key: action.key, modifiers: action.modifiers };
      ack.parse(
        zendriverStructured(
          await this.client.call(
            'browser_key_sequence',
            { css: before.focused ? ':focus' : 'body', sequence: [step], return_snapshot: false },
            ctx.signal,
          ),
        ),
      );
    }
    const current = await this.humanBinding(ctx.signal);
    if (current.tabId !== binding.tabId || current.documentRevision !== binding.documentRevision)
      return { effect: 'applied' };
    const after = await this.humanFocus(ctx.signal);
    if (action.type === 'text' && before.revision !== after.revision) return { effect: 'applied' };
    return {
      effect: 'applied',
      keyboard: {
        tabId: current.tabId,
        documentRevision: current.documentRevision,
        focusRevision: after.revision,
      },
    };
  }
  async open(signal?: AbortSignal, expectedChromeVersion = '155.0.8059.84'): Promise<void> {
    const configured = z
      .object({
        active_profile: z.literal('native'),
        active_overrides: z.object({
          bypass_csp: z.literal(false),
          native_isolation: z.literal(true),
        }),
      })
      .parse(
        zendriverStructured(
          await this.client.call(
            'browser_set_stealth_profile',
            { profile: 'native', overrides: { bypass_csp: false, native_isolation: true } },
            signal,
          ),
        ),
      );
    void configured;
    z.object({
      chrome_version: z.literal(`Chrome/${expectedChromeVersion}`),
      headless: z.literal(true),
      profile: z.literal('native'),
    }).parse(
      zendriverStructured(
        await this.client.call(
          'browser_open',
          { headless: true, stealth_profile: 'native', input_profile: 'native' },
          signal,
        ),
      ),
    );
    z.object({
      width: z.number().positive().max(BROWSER_LIMITS.imageDimension),
      height: z.number().positive().max(BROWSER_LIMITS.imageDimension),
      scale: z.literal(1),
    }).parse(
      await this.evaluate('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})', signal),
    );
  }
  private async inspect(signal?: AbortSignal): Promise<BrowserDriverState> {
    const status = z
      .object({
        open: z.literal(true),
        tab_count: z.literal(1),
        current_tab: z.object({ id: z.string().min(1), url: z.string() }),
      })
      .parse(zendriverStructured(await this.client.call('browser_status', {}, signal)));
    let page = z
      .object({ url: z.string(), documentRevision: z.string(), browserVersion: z.string() })
      .parse(await this.evaluate(browserStateScript, signal));
    // A failed navigation leaves the owned tab on Chrome's internal error
    // page: the tab keeps the failed destination while the document reports
    // the internal error URL. That is an unreachable destination, never a
    // stale binding or an adapter malfunction.
    const errorPage =
      page.url === CHROME_ERROR_PAGE_URL || status.current_tab.url === CHROME_ERROR_PAGE_URL;
    if (!errorPage && status.current_tab.url !== page.url) {
      // The tab-status and document probes race same-tab URL updates (e.g. a
      // post-load history.replaceState). Re-read the document once and accept
      // it when stable; a still-moving document is a stale observation.
      const again = z
        .object({ url: z.string(), documentRevision: z.string(), browserVersion: z.string() })
        .parse(await this.evaluate(browserStateScript, signal));
      if (again.url !== page.url || again.documentRevision !== page.documentRevision)
        throw new BrowserDriverError('STALE_TARGET');
      page = again;
    }
    const state = browserDriverStateSchema.parse({ ...page, tabId: status.current_tab.id });
    if (
      state.url !== 'about:blank' &&
      state.url !== CHROME_ERROR_PAGE_URL &&
      !browserUrlSchema.safeParse(state.url).success
    )
      throw new BrowserDriverError(
        'NOT_AUTHORIZED',
        'The owned tab contains an unsupported document scheme. Only HTTP(S) evidence is allowed; report the document access limitation.',
        'conclude',
      );
    return state;
  }
  async authorize(
    sessionId: string,
    operation: string,
    url: string | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserBinding> {
    if (sessionId !== this.sessionId || !(await this.authorizeSession(sessionId, signal)))
      throw new BrowserDriverError('NOT_AUTHORIZED');
    if (url !== undefined) browserUrlSchema.parse(url);
    const state = await this.inspect(signal);
    if (state.url === CHROME_ERROR_PAGE_URL && (operation !== 'navigate' || url === undefined))
      // Only an explicit validated HTTP(S) navigation may move the owned tab
      // away from Chrome's error page; reading it cannot produce evidence.
      throw new BrowserDriverError(
        'PAGE_UNAVAILABLE',
        'The owned tab is on a Chrome network error page. Navigate to a valid HTTP(S) source to recover; reading or screenshotting this error page cannot produce evidence.',
        'navigate',
      );
    if (url && operation !== 'navigate' && url !== state.url)
      throw new BrowserDriverError('STALE_TARGET');
    return this.binding(state);
  }
  async verify(binding: BrowserBinding, ctx: { signal?: AbortSignal }): Promise<void> {
    const state = await this.inspect(ctx.signal);
    if (
      binding.driver?.runtimeGeneration !== this.generation ||
      binding.tabId !== state.tabId ||
      binding.documentRevision !== state.documentRevision
    )
      throw new BrowserDriverError('STALE_TARGET');
  }
  async surface(
    _binding: BrowserBinding,
    filter: 'interactive' | 'all',
    scope: number[] | undefined,
    ctx: { signal?: AbortSignal },
  ): Promise<BrowserSurface> {
    return browserSurfaceSchema.parse(
      await this.evaluate(browserSurfaceScript(filter, scope), ctx.signal),
    );
  }
  async capture(
    _binding: BrowserBinding,
    mode: 'article' | 'documentation',
    scope: number[] | undefined,
    ctx: { signal?: AbortSignal },
  ): Promise<BrowserCapture> {
    return browserCaptureSchema.parse(
      await this.evaluate(browserExtractor(mode, scope), ctx.signal),
    );
  }
  async navigate(
    _binding: BrowserBinding,
    url: string,
    ctx: { signal?: AbortSignal },
  ): Promise<void> {
    browserUrlSchema.parse(url);
    try {
      z.object({ url: z.string(), title: z.string() }).parse(
        zendriverStructured(
          await this.client.call(
            'browser_goto',
            { url, wait_for: 'none', return_snapshot: false },
            ctx.signal,
          ),
        ),
      );
      await this.client.call('browser_wait_for_load', { ready_state: 'interactive' }, ctx.signal);
    } catch (error) {
      ctx.signal?.throwIfAborted();
      try {
        if ((await this.inspect(ctx.signal)).url === CHROME_ERROR_PAGE_URL)
          throw new BrowserDriverError(
            'PAGE_UNAVAILABLE',
            'The requested page could not be reached. Check the host-managed guest egress or proxy gateway, then navigate to another validated HTTP(S) source.',
            'navigate',
          );
      } catch (inspectionError) {
        if (
          inspectionError instanceof BrowserDriverError &&
          inspectionError.code === 'PAGE_UNAVAILABLE'
        )
          throw inspectionError;
      }
      throw error;
    }
  }
  async act(
    _binding: BrowserBinding,
    raw: Parameters<BrowserDriverPort['act']>[1],
    ctx: { signal?: AbortSignal },
  ): Promise<void> {
    const action = browserDriverActionSchema.parse(raw);
    let name: string;
    let args: Record<string, unknown>;
    if (action.operation === 'click' && action.point) {
      name = 'browser_mouse';
      args = { action: 'click', ...action.point };
    } else if (action.operation === 'click') {
      name = 'browser_click';
      args = { css: browserTargetSelector(action.path!) };
    } else if (action.operation === 'fill') {
      name = 'browser_type';
      args = { css: browserTargetSelector(action.path), text: action.text, clear_first: true };
    } else if (action.operation === 'key') {
      name = 'browser_press';
      args = { css: browserTargetSelector(action.path), key: action.key };
    } else {
      name = 'browser_scroll';
      args = {
        dx:
          action.direction === 'left'
            ? -action.pixels
            : action.direction === 'right'
              ? action.pixels
              : 0,
        dy:
          action.direction === 'up'
            ? -action.pixels
            : action.direction === 'down'
              ? action.pixels
              : 0,
      };
    }
    const result = zendriverStructured(
      await this.client.call(name, { ...args, return_snapshot: false }, ctx.signal),
    );
    if (action.operation === 'scroll')
      z.object({ scroll_x: z.number().finite(), scroll_y: z.number().finite() }).parse(result);
    else ack.parse(result);
  }
  async pointAllowed(
    _binding: BrowserBinding,
    point: { x: number; y: number },
    ctx: { signal?: AbortSignal },
  ): Promise<boolean> {
    return z
      .object({ allowed: z.boolean() })
      .parse(await this.evaluate(browserPointScript(point.x, point.y), ctx.signal)).allowed;
  }
  async readiness(
    _binding: BrowserBinding,
    text: string,
    timeoutMs: number,
    ctx: { signal?: AbortSignal },
  ): Promise<'ready' | 'timed_out'> {
    return z
      .enum(['ready', 'timed_out'])
      .parse(await this.evaluate(browserReadinessScript(text, timeoutMs), ctx.signal));
  }
  async accessibility(
    _binding: BrowserBinding,
    surface: Parameters<BrowserDriverPort['accessibility']>[1],
  ): Promise<string> {
    return surface.targets
      .map(
        (target) =>
          `- ${target.role} ${JSON.stringify(target.name)}${target.disabled ? ' [disabled]' : ''}`,
      )
      .join('\n')
      .slice(0, 64000);
  }
  async paint(
    _binding: BrowserBinding,
    ctx: { signal?: AbortSignal },
  ): Promise<'ready' | 'timed_out'> {
    return z
      .enum(['ready', 'timed_out'])
      .parse(await this.evaluate(browserPaintScript, ctx.signal));
  }
  async screenshot(_binding: BrowserBinding, ctx: { signal?: AbortSignal }): Promise<Uint8Array> {
    const result = await this.client.call(
      'browser_screenshot',
      { format: 'png', full_page: false },
      ctx.signal,
      true,
    );
    const metadata = z
      .object({
        format: z.literal('png'),
        byte_len: z.number().int().positive().max(BROWSER_LIMITS.image),
      })
      .parse(result.structuredContent);
    if (result.content.length !== 1) throw new BrowserDriverError('INVALID_OUTPUT');
    const image = z
      .object({
        type: z.literal('image'),
        mimeType: z.literal('image/png'),
        data: z
          .string()
          .max(Math.ceil(BROWSER_LIMITS.image / 3) * 4)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      })
      .parse(result.content[0]);
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length !== metadata.byte_len) throw new BrowserDriverError('INVALID_OUTPUT');
    return bytes;
  }
}
