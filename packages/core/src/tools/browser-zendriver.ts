import { createHash } from 'node:crypto';
import { z } from 'zod';
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
} from '@trinity-harness/contracts';
import { browserExtractor } from './browser-extractor.js';
import {
  browserSurfaceScript,
  browserTargetSelector,
  browserReadinessScript,
} from './browser-interactions.js';
import {
  browserPointScript,
  browserPaintScript,
  browserStateScript,
} from './browser-driver-scripts.js';
import { BrowserDriverError } from './browser-driver-error.js';
import { ZENDRIVER_VERSION, zendriverStructured, type ZendriverClient } from './zendriver-mcp.js';

const ack = z.object({ ok: z.literal(true) });
/** One instance is bound to one supervisor-owned MCP connection and generation. */
export class ZendriverBrowserDriver implements BrowserDriverPort, BrowserAccessPort {
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
    const state = browserDriverStateSchema.parse({
      ...z
        .object({ url: z.string(), documentRevision: z.string(), browserVersion: z.string() })
        .parse(await this.evaluate(browserStateScript, signal)),
      tabId: status.current_tab.id,
    });
    if (status.current_tab.url !== state.url) throw new BrowserDriverError('STALE_TARGET');
    if (state.url !== 'about:blank') browserUrlSchema.parse(state.url);
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
    if (url && operation !== 'navigate' && url !== state.url)
      throw new BrowserDriverError('STALE_TARGET');
    return {
      bindingId: createHash('sha256').update(`${sessionId}\n${this.generation}`).digest('hex'),
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
