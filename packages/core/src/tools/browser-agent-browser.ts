import { BrowserDriverError } from './browser-driver-error.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  BROWSER_LIMITS,
  browserCaptureSchema,
  browserSurfaceSchema,
  type BrowserDriverPort,
  type BrowserBinding,
  type ToolContext,
} from '@trinity-harness/contracts';
import { matchesBrowserCdpEndpoint, unwrapBrowserCliOutput } from './browser-cdp.js';
import { browserExtractor } from './browser-extractor.js';
import {
  browserSurfaceScript,
  browserTargetSelector,
  browserReadinessScript,
} from './browser-interactions.js';
import {
  browserPointScript,
  browserDomClickScript,
  browserPaintScript,
} from './browser-driver-scripts.js';

/** Mutating operations may partially apply; retry them only on sandbox timeouts. */
const mutatingCommands = new Set(['click', 'fill', 'focus', 'press', 'mouse', 'scroll']);
/** Bounded backoff for transient adapter failures (busy tab, settling websocket). */
const transientBackoffMs = [250, 500];

async function cli(ctx: ToolContext, binding: BrowserBinding, args: string[]): Promise<unknown> {
  if (!ctx.sandbox.execArgv || !/^[A-Za-z0-9_-]{1,200}$/.test(binding.cliSession))
    throw new Error('Invalid CLI binding');
  const flags = ['--session', binding.cliSession, '--json', '--pin-tab'];
  if (binding.cdpEndpoint) flags.push('--cdp', binding.cdpEndpoint);
  const mutating = mutatingCommands.has(args[0] ?? '');
  for (let attempt = 0; ; attempt++) {
    const result = await ctx.sandbox.execArgv('agent-browser', [...flags, ...args], {
      signal: ctx.signal,
      timeoutMs: 30_000,
      maxOutputBytes: BROWSER_LIMITS.transport,
    });
    ctx.signal?.throwIfAborted();
    if (result.outputOverflow) throw new BrowserDriverError('TRANSPORT_OVERFLOW');
    if (result.exitCode === 0) return unwrapBrowserCliOutput(result.stdout);
    // Missing CLI binary is a permanent configuration failure; bounded
    // retries cannot recover it. Read-only commands may retry any transient
    // non-zero exit; mutating commands retry only sandbox timeouts (124),
    // where the operation was killed before it could partially apply.
    // Recovery is exhausted: the caller should report the channel failure,
    // not retry at the model level.
    if (
      /ENOENT|not found/i.test(result.stderr) ||
      (mutating && result.exitCode !== 124) ||
      attempt >= transientBackoffMs.length
    )
      throw new BrowserDriverError('DRIVER_FAILED', undefined, 'conclude');
    await delay(transientBackoffMs[attempt]!, undefined, { signal: ctx.signal });
  }
}

export const agentBrowserDriver: BrowserDriverPort = {
  async verify(binding, ctx) {
    const version = await ctx.sandbox.execArgv?.('agent-browser', ['--version'], {
      signal: ctx.signal,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    if (
      !version ||
      version.outputOverflow ||
      version.exitCode !== 0 ||
      version.stdout.trim() !== `agent-browser ${binding.cliVersion}`
    )
      throw new BrowserDriverError('DISABLED');
    if (binding.cdpEndpoint) {
      const connection = z
        .object({ cdpUrl: z.string() })
        .parse(await cli(ctx, binding, ['get', 'cdp-url']));
      if (!matchesBrowserCdpEndpoint(binding.cdpEndpoint, connection.cdpUrl))
        throw new BrowserDriverError('NOT_AUTHORIZED');
    }
  },
  async surface(binding, filter, scope, ctx) {
    return browserSurfaceSchema.parse(
      await cli(ctx, binding, ['eval', browserSurfaceScript(filter, scope)]),
    );
  },
  async capture(binding, mode, scope, ctx) {
    return browserCaptureSchema.parse(
      await cli(ctx, binding, ['eval', browserExtractor(mode, scope)]),
    );
  },
  async navigate(binding, url, ctx) {
    await cli(ctx, binding, ['open', url]);
    await cli(ctx, binding, ['wait', '--load', 'domcontentloaded']);
  },
  async act(binding, action, ctx) {
    if (action.operation === 'click' && action.point) {
      await cli(ctx, binding, ['mouse', 'move', String(action.point.x), String(action.point.y)]);
      try {
        await cli(ctx, binding, ['mouse', 'down']);
      } finally {
        await cli({ ...ctx, signal: AbortSignal.timeout(3000) }, binding, ['mouse', 'up']);
      }
    } else if (action.operation === 'click' && action.dom) {
      z.object({ applied: z.literal(true) }).parse(
        await cli(ctx, binding, ['eval', browserDomClickScript(action.path!)]),
      );
    } else if (action.operation === 'click')
      await cli(ctx, binding, ['click', browserTargetSelector(action.path!)]);
    else if (action.operation === 'fill')
      await cli(ctx, binding, ['fill', browserTargetSelector(action.path), action.text]);
    else if (action.operation === 'key') {
      await cli(ctx, binding, ['focus', browserTargetSelector(action.path)]);
      await cli(ctx, binding, ['press', action.key]);
    } else await cli(ctx, binding, ['scroll', action.direction, String(action.pixels)]);
  },
  async pointAllowed(binding, point, ctx) {
    return z
      .object({ allowed: z.boolean() })
      .parse(await cli(ctx, binding, ['eval', browserPointScript(point.x, point.y)])).allowed;
  },
  async readiness(binding, text, timeoutMs, ctx) {
    return z
      .enum(['ready', 'timed_out'])
      .parse(await cli(ctx, binding, ['eval', browserReadinessScript(text, timeoutMs)]));
  },
  async accessibility(binding, _surface, filter, scope, ctx) {
    return z
      .object({ snapshot: z.string().max(64000) })
      .parse(
        await cli(ctx, binding, [
          'snapshot',
          ...(filter === 'interactive' ? ['-i'] : []),
          '-c',
          '-d',
          '8',
          ...(scope ? ['-s', browserTargetSelector(scope)] : []),
        ]),
      ).snapshot;
  },
  async paint(binding, ctx) {
    await cli(ctx, binding, ['tab', binding.tabId]);
    return z
      .enum(['ready', 'timed_out'])
      .parse(await cli(ctx, binding, ['eval', browserPaintScript]));
  },
  async screenshot(binding, ctx) {
    if (!ctx.sandbox.readBytes || !ctx.sandbox.removeFile) throw new BrowserDriverError('DISABLED');
    const file = path.join(ctx.workspaceRoot, `.trinity-browser-${randomUUID()}.png`);
    try {
      await cli(ctx, binding, ['screenshot', file, '--screenshot-format', 'png']);
      return await ctx.sandbox.readBytes(file, BROWSER_LIMITS.image);
    } finally {
      await ctx.sandbox.removeFile(file);
    }
  },
};
