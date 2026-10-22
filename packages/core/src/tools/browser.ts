import type { ToolEffect } from '@trinity-harness/contracts';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { z } from 'zod';
import {
  BROWSER_LIMITS,
  browserArgumentsSchema,
  browserCaptureSchema,
  browserErrorSchema,
  browserObservationSchema,
  browserUrlSchema,
  browserImageSchema,
  browserReadinessSchema,
  browserActionOperations,
  type BrowserInteraction,
  type SessionEvent,
  type BlobStore,
  type BrowserAccessPort,
  type BrowserDriverPort,
  type BrowserRuntimePort,
  type BrowserArguments,
  type BrowserBinding,
  type BrowserCapture,
  type BrowserObservation,
  type BrowserResult,
  type SessionStore,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@trinity-harness/contracts';
import {
  browserArtifactUri,
  browserDeliveries,
  browserHash,
  browserPromptIndex,
  loadBrowserObservation,
} from './browser-artifacts.js';
import { BrowserDriverError as BrowserFailure } from './browser-driver-error.js';
import { CdpAccessError } from './browser-cdp.js';
import { agentBrowserDriver } from './browser-agent-browser.js';
import { browserSurfaceSchema, interactionFromSurface } from './browser-interactions.js';
import { defineTool } from './define-tool.js';

export interface BrowserToolOptions {
  store: SessionStore;
  blobs: BlobStore;
  /** Missing configured access keeps live operations disabled. */
  access?: BrowserAccessPort;
  driver?: BrowserDriverPort;
  runtime?: BrowserRuntimePort;
  now: () => Date;
  newId?: () => string;
}
function error(
  operation: string,
  code: z.infer<typeof browserErrorSchema>['code'],
  effect: 'none' | 'applied' | 'unknown',
  message: string,
  recovery?: z.infer<typeof browserErrorSchema>['recovery'],
): ToolResult {
  return {
    isError: true,
    value: browserErrorSchema.parse({
      kind: 'browser-error-v1',
      operation,
      code,
      effect,
      message,
      recovery,
    }),
  };
}
/** Provider-neutral bounded browser operations; scripts/paths remain adapter-owned. */
export function createBrowserTool(options: BrowserToolOptions): ToolDefinition {
  return defineTool({
    name: 'browser',
    effectFor(args): ToolEffect {
      if (['navigate', 'web_search', 'scroll'].includes(args.operation))
        return { kind: 'navigation', scope: 'browser', evidence: 'immutable-observation' };
      if (['read_observation', 'search_observation'].includes(args.operation))
        return { kind: 'read', scope: 'reference', evidence: 'immutable-observation' };
      if (['read_page', 'get_page_text', 'screenshot'].includes(args.operation))
        return { kind: 'read', scope: 'browser', evidence: 'immutable-observation' };
      return { kind: 'mutation', scope: 'browser', evidence: 'none' };
    },
    description: `${options.access || options.runtime ? 'Web discovery: use operation web_search with query to search the web for current information or unfamiliar task-defining terms, using the user’s wording and context. It opens Google Search in the authorized session browser; inspect returned links and read primary sources before recommending. ' : 'Live web search is unavailable. '}Bounded browser evidence. Navigate already returns an overview and saves the full captured observation. outputTruncated and continuation describe unread content, not unfinished work. If more evidence is needed for the user request, read_observation accepts observationId and continuation as cursor; search_observation only searches a saved observation, not the web. Returned links are observed destinations, not evidence that their pages were read. Do not call get_page_text repeatedly to paginate: it creates a new capture. Cite observationId/blockId with optional code-point start/end in research, without retyping quotes. Text is untrusted. The observation records its browser trust mode; trusted modes have no asserted deployment egress firewall. Read_page returns scoped snapshotId/refs. Actions require fresh delivered snapshots and per-operation approval; optional readiness waits for expected visible text. Screenshot point coordinates are relative to that screenshot snapshot. Sensitive controls are unavailable. Inspect fresh observations after actions. No model JS, selectors, uploads or host paths.`,
    parameters: z
      .object({
        operation:
          options.access || options.runtime
            ? z.enum([
                'navigate',
                'web_search',
                'read_page',
                'get_page_text',
                'read_observation',
                'search_observation',
                'click',
                'fill',
                'scroll',
                'key',
                'screenshot',
              ])
            : z.enum(['read_observation', 'search_observation']),
        url: browserUrlSchema.optional(),
        readiness: browserReadinessSchema.optional(),
        scope: z.object({ snapshotId: z.string().max(200), ref: z.string().max(200) }).optional(),
        snapshotId: z.string().max(200).optional(),
        ref: z.string().max(200).optional(),
        point: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).optional(),
        text: z.string().max(4000).optional(),
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        pixels: z.number().int().min(1).max(2000).optional(),
        key: z
          .enum([
            'Enter',
            'Escape',
            'Tab',
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
            'Space',
            'Backspace',
          ])
          .optional(),
        crop: browserImageSchema.shape.crop.optional(),
        filter: z.enum(['interactive', 'all']).optional(),
        mode: z.enum(['article', 'documentation']).optional(),
        observationId: z.string().max(200).optional(),
        blockIds: z
          .array(z.string().max(200))
          .min(1)
          .max(20)
          .optional()
          .describe(
            'Exact blocks only. Selecting an outline heading does not include its body. Use sectionId or cursor for surrounding content.',
          ),
        sectionId: z
          .string()
          .max(200)
          .optional()
          .describe(
            'Read a heading and its section content using the heading block ID. Omit blockIds to include the body.',
          ),
        cursor: z
          .object({ blockId: z.string().max(200), offset: z.number().int().nonnegative() })
          .optional()
          .describe(
            'Start at this block and Unicode offset, continuing through subsequent blocks. Use returned continuation to paginate.',
          ),
        query: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            options.access || options.runtime
              ? 'Web discovery query for web_search; literal saved-page query for search_observation.'
              : 'Literal saved-page query for search_observation.',
          ),
      })
      .strict()
      .superRefine((args, ctx) => {
        if (!browserArgumentsSchema.safeParse(args).success)
          ctx.addIssue({ code: 'custom', message: 'Invalid browser operation arguments' });
      }),
    concurrency: 'exclusive',
    timeoutMs: 120_000,
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const args = browserArgumentsSchema.parse(rawArgs);
      const saved =
        args.operation === 'read_observation' || args.operation === 'search_observation';
      const state: { effect: 'none' | 'applied' | 'unknown' } = { effect: 'none' };
      if (browserActionOperations.some((op) => op === args.operation) && !ctx.permissionGranted)
        return error(
          args.operation,
          'NOT_AUTHORIZED',
          'none',
          'Browser action requires per-call policy/approval authorization.',
        );
      try {
        ctx.signal?.throwIfAborted();
        if (!ctx.callId)
          return error(args.operation, 'NOT_AUTHORIZED', 'none', 'Missing originating call');
        if (!saved && options.runtime) {
          if (
            args.operation === 'navigate' ||
            args.operation === 'web_search' ||
            browserActionOperations.some((op) => op === args.operation)
          )
            state.effect = 'unknown';
          return await options.runtime.execute(
            {
              sessionId: ctx.sessionId,
              callId: ctx.callId,
              args,
              permissionGranted: ctx.permissionGranted === true,
            },
            ctx.signal,
          );
        }
        const events = await options.store.load(ctx.sessionId);
        ctx.signal?.throwIfAborted();
        const deliveries = browserDeliveries(events, ctx.sessionId, browserPromptIndex(events));
        let observation: BrowserObservation;
        if (saved) {
          try {
            observation = await loadBrowserObservation(
              options.blobs,
              events,
              ctx.sessionId,
              args.observationId,
              ctx.signal,
            );
          } catch {
            return error(
              args.operation,
              'ARTIFACT_UNAVAILABLE',
              'none',
              'No authorized intact saved observation. Never regenerate it from a live page.',
            );
          }
        } else {
          if (!options.access)
            return error(
              args.operation,
              'DISABLED',
              'none',
              'No verified browser network and ownership boundary is installed.',
            );
          observation = await captureLive(
            args,
            ctx,
            options,
            events,
            deliveries.map((d) => d.result),
            state,
          );
        }
        const limit = saved ? BROWSER_LIMITS.focused : BROWSER_LIMITS.overview;
        const result = deliver(
          observation,
          args,
          ctx.callId,
          limit,
          deliveries.map((d) => d.result),
        );
        if (!result)
          return error(
            args.operation,
            'LIMIT_REACHED',
            state.effect,
            'The requested response could not fit. Use a smaller saved block scope or focused search.',
            'focused_read',
          );
        ctx.signal?.throwIfAborted();
        return { value: result, isError: false };
      } catch (err) {
        return error(
          args.operation,
          ctx.signal?.aborted
            ? 'CANCELLED'
            : err instanceof BrowserPersistenceFailure
              ? 'PERSIST_FAILED'
              : err instanceof BrowserFailure
                ? err.code
                : 'INVALID_OUTPUT',
          state.effect,
          err instanceof BrowserFailure && err.message !== err.code
            ? err.message
            : 'Browser operation did not produce committed evidence. If effects are unknown, reobserve before retrying. Inspect the error; authorization failures require an access change, not a different site.',
          err instanceof BrowserFailure
            ? (err.recovery ?? (err.code === 'LIMIT_REACHED' ? 'focused_read' : undefined))
            : undefined,
        );
      }
    },
  });
}
async function persistCapture(
  capture: BrowserCapture,
  binding: BrowserBinding,
  ctx: ToolContext,
  options: BrowserToolOptions,
  extras: Pick<BrowserObservation, 'interaction' | 'image' | 'readinessCondition'> = {},
  observationId = (options.newId ?? randomUUID)(),
): Promise<BrowserObservation> {
  const payload = {
    ...capture,
    ...extras,
    observationId,
    sessionId: ctx.sessionId,
    bindingId: binding.bindingId,
    tabId: binding.tabId,
    documentRevision: binding.documentRevision,
    cliVersion: binding.cliVersion,
    browserVersion: binding.browserVersion,
    capturedAt: options.now().toISOString(),
    ...(binding.driver ? { driver: binding.driver } : {}),
    ...(binding.securityMode ? { securityMode: binding.securityMode } : {}),
  };
  // Ordinals belong to the immutable extraction, never to text identity.
  if (payload.blocks.some((b, i) => b.id !== `b${i}`)) throw new BrowserFailure('INVALID_OUTPUT');
  const observation = browserObservationSchema.parse({ ...payload, hash: browserHash(payload) });
  const bytes = new TextEncoder().encode(JSON.stringify(observation));
  if (bytes.byteLength > BROWSER_LIMITS.artifact) throw new BrowserFailure('TRANSPORT_OVERFLOW');
  ctx.signal?.throwIfAborted();
  const uri = browserArtifactUri(ctx.sessionId, observation.observationId);
  // Do not overwrite even when an injected ID source accidentally repeats.
  if (await options.blobs.getMeta(uri)) throw new BrowserFailure('INVALID_OUTPUT');
  try {
    await options.blobs.put(uri.slice(7), bytes, { mimeType: 'application/json' });
  } catch {
    throw new BrowserPersistenceFailure();
  }
  ctx.signal?.throwIfAborted();
  return observation;
}
class BrowserPersistenceFailure extends Error {
  readonly code = 'PERSIST_FAILED';
}

export function deliver(
  observation: BrowserObservation,
  args: BrowserArguments,
  callId: string,
  limit: number,
  previous: readonly BrowserResult[] = [],
): BrowserResult | null {
  const saved = args.operation === 'read_observation' || args.operation === 'search_observation';
  const result: BrowserResult = {
    kind: 'browser-result-v1',
    operation: args.operation,
    callId,
    sessionId: observation.sessionId,
    observationId: observation.observationId,
    artifactUri: browserArtifactUri(observation.sessionId, observation.observationId),
    url: observation.url,
    title: observation.title,
    capturedAt: observation.capturedAt,
    ...(observation.driver ? { driver: observation.driver } : {}),
    bindingId: observation.bindingId,
    tabId: observation.tabId,
    documentRevision: observation.documentRevision,
    readiness: observation.readiness,
    saved,
    ...(observation.securityMode ? { securityMode: observation.securityMode } : {}),
    captureTruncated: observation.captureTruncated,
    representation: observation.representation,
    scope: observation.scope,
    exclusions: observation.exclusions,
    publishedAt: observation.publishedAt,
    outline: observation.blocks
      .filter((b) => b.kind === 'heading')
      .slice(0, 16)
      .map((b) => ({ blockId: b.id, title: Array.from(b.text).slice(0, 80).join('') })),
    duplicateSuppressed: false,
    outputTruncated: false,
    blocks: [],
    receipt: [],
    continuation: null,
    ...(!saved &&
    (args.operation === 'navigate' ||
      args.operation === 'web_search' ||
      browserActionOperations.some((op) => op === args.operation))
      ? { effect: 'applied' as const }
      : {}),
    ...(observation.readinessCondition
      ? { readinessCondition: observation.readinessCondition }
      : {}),
    ...(!saved && observation.interaction
      ? {
          snapshot: {
            ...observation.interaction,
            snapshotId: observation.observationId,
            targets: observation.interaction.targets.map(({ path: _path, ...target }) => {
              void _path;
              return target;
            }),
          },
        }
      : {}),
    ...((args.operation === 'screenshot' || args.operation === 'read_observation') &&
    observation.image
      ? { image: observation.image }
      : {}),
  };
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(result)) <= limit;
  let candidates = observation.blocks;
  if (args.operation === 'read_observation') {
    if (
      args.blockIds?.some((id) => !observation.blocks.some((b) => b.id === id)) ||
      (args.sectionId &&
        !observation.blocks.some((b) => b.id === args.sectionId && b.kind === 'heading'))
    )
      throw new BrowserFailure('INVALID_OUTPUT');
    candidates = candidates.filter(
      (b) =>
        (!args.blockIds || args.blockIds.includes(b.id)) &&
        (!args.sectionId || b.sectionId === args.sectionId),
    );
  }
  const cursor = saved ? args.cursor : undefined;
  if (cursor) {
    const index = candidates.findIndex((b) => b.id === cursor.blockId);
    if (index < 0 || cursor.offset > Array.from(candidates[index]!.text).length)
      throw new BrowserFailure('INVALID_OUTPUT');
    candidates = candidates.slice(index);
  }
  const links = candidates
    .filter((block) => args.operation !== 'search_observation' || block.text.includes(args.query))
    .flatMap((block) => block.links.map((link) => ({ blockId: block.id, ...link })));
  if (links.length) {
    result.links = [];
    result.linksTruncated = false;
    const linkBudget = Math.floor(limit / 3);
    for (const link of links) {
      result.links.push(link);
      if (
        result.links.length > 20 ||
        Buffer.byteLength(JSON.stringify(result.links)) > linkBudget
      ) {
        result.links.pop();
        result.linksTruncated = true;
        continue;
      }
    }
  }
  // Include the cursor before fitting metadata, even when no block text fits yet.
  result.continuation = candidates.length
    ? { blockId: candidates[0]!.id, offset: cursor?.offset ?? 0 }
    : null;
  const metadataLimit = limit - (candidates.length ? Math.min(2048, Math.floor(limit / 2)) : 0);
  const metadataFits = (): boolean => Buffer.byteLength(JSON.stringify(result)) <= metadataLimit;
  while (!metadataFits() && result.snapshot?.targets.length) {
    result.snapshot.targets.pop();
    result.snapshot.truncated = true;
  }
  while (!metadataFits() && result.outline.length) result.outline.pop();
  if (!fits()) return null;
  let exhausted = true;
  for (const block of candidates) {
    const points = Array.from(block.text);
    let start = cursor?.blockId === block.id ? cursor.offset : 0;
    const covered = previous
      .filter((p) => p.observationId === observation.observationId)
      .flatMap((p) => p.receipt)
      .filter((r) => r.blockId === block.id)
      .sort((a, b) => a.start - b.start);
    let searchEnd = points.length;
    if (args.operation === 'search_observation') {
      // Skip already exposed matches; a duplicate search must not return unrelated text.
      let found = block.text.indexOf(args.query, points.slice(0, start).join('').length);
      let matchStart = -1;
      while (found >= 0) {
        const begin = Array.from(block.text.slice(0, found)).length;
        const end = begin + Array.from(args.query).length;
        let seenThrough = begin;
        for (const range of covered) {
          if (range.start > seenThrough) break;
          if (range.end > seenThrough) seenThrough = range.end;
        }
        if (seenThrough < end) {
          matchStart = begin;
          searchEnd = Math.min(points.length, end + 80);
          break;
        }
        result.duplicateSuppressed = true;
        found = block.text.indexOf(args.query, found + args.query.length);
      }
      if (matchStart < 0) continue;
      start = Math.max(start, matchStart - 80);
    }
    for (const range of covered)
      if (range.start <= start && range.end > start) {
        start = range.end;
        result.duplicateSuppressed = true;
      }
    if (start >= points.length) continue;
    let end = searchEnd;
    // Deliver only a gap, rather than repeating ranges already present in active history.
    const next = covered.find((r) => r.start > start);
    if (next) end = Math.min(end, next.start);
    const item = { id: block.id, kind: block.kind, text: '', start, end: start };
    const range = { blockId: block.id, start, end: start };
    const previousContinuation = result.continuation;
    result.blocks.push(item);
    result.receipt.push(range);
    const setEnd = (offset: number): void => {
      item.text = points.slice(start, offset).join('');
      item.end = offset;
      range.end = offset;
      result.continuation = { blockId: block.id, offset };
    };
    let low = start,
      high = end;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      setEnd(mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    setEnd(low);
    if (low === start) {
      result.blocks.pop();
      result.receipt.pop();
      // The prior cursor was already sized with its delivered block. Resuming at
      // that block's end also reaches this block, without growing the envelope.
      result.continuation = previousContinuation;
      exhausted = false;
      break;
    }
    if (low < points.length) {
      exhausted = false;
      break;
    }
  }
  if (exhausted) result.continuation = null;
  result.outputTruncated = result.continuation !== null;
  if (!fits()) return null;
  return result;
}

async function captureLive(
  requested: BrowserArguments,
  ctx: ToolContext,
  options: BrowserToolOptions,
  events: readonly SessionEvent[],
  deliveries: readonly BrowserResult[],
  state: { effect: 'none' | 'applied' | 'unknown' },
): Promise<BrowserObservation> {
  const args =
    requested.operation === 'web_search'
      ? {
          operation: 'navigate' as const,
          url: `https://www.google.com/search?${new URLSearchParams({ q: requested.query })}`,
        }
      : requested;
  const access = options.access!;
  const authorize = async (url?: string): Promise<BrowserBinding> => {
    try {
      return await access.authorize(ctx.sessionId, args.operation, url, ctx.signal);
    } catch (err) {
      if (err instanceof CdpAccessError) throw err.failure;
      if (err instanceof BrowserFailure) throw err;
      throw new BrowserFailure(
        'NOT_AUTHORIZED',
        'Browser access was denied. Report the limitation; changing sites will not authorize access.',
        'conclude',
      );
    }
  };
  let binding = await authorize(args.operation === 'navigate' ? args.url : undefined);
  const driver = options.driver ?? agentBrowserDriver;
  await driver.verify(binding, ctx);
  const revalidate = async (url?: string, allowRevision = false): Promise<void> => {
    const next = await authorize(url);
    if (
      next.bindingId !== binding.bindingId ||
      next.tabId !== binding.tabId ||
      (!allowRevision && next.documentRevision !== binding.documentRevision) ||
      (url && next.observedUrl !== undefined && next.observedUrl !== url)
    )
      throw new BrowserFailure('STALE_TARGET');
    binding = next;
  };
  const surface = async (filter: 'interactive' | 'all' = 'all', scopePath?: number[]) =>
    browserSurfaceSchema.parse(await driver.surface(binding, filter, scopePath, ctx));
  let scopePath: number[] | undefined;
  let coordinate: { x: number; y: number } | undefined;
  let readiness: 'ready' | 'timed_out' | undefined;
  const isAction = browserActionOperations.some((op) => op === args.operation);
  const scope = 'scope' in args ? args.scope : undefined;
  if (isAction || scope) {
    const snapshotId = 'snapshotId' in args ? args.snapshotId : scope!.snapshotId;
    const source = [...deliveries]
      .reverse()
      .find((d) => d.snapshot?.snapshotId === snapshotId && !d.saved);
    const latestCall = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'tool/call' &&
          event.name === 'browser' &&
          event.callId !== ctx.callId &&
          !['read_observation', 'search_observation'].includes(
            (event.args as { operation?: string } | null)?.operation ?? '',
          ),
      );
    if (!source || latestCall?.type !== 'tool/call' || latestCall.callId !== source.callId)
      throw new BrowserFailure('STALE_TARGET');
    const observation = await loadBrowserObservation(
      options.blobs,
      events,
      ctx.sessionId,
      source.observationId,
      ctx.signal,
    );
    const snapshot = observation.interaction;
    if (
      !snapshot ||
      observation.bindingId !== binding.bindingId ||
      observation.tabId !== binding.tabId ||
      observation.documentRevision !== binding.documentRevision ||
      (binding.observedUrl && binding.observedUrl !== observation.url)
    )
      throw new BrowserFailure('STALE_TARGET');
    const current = await surface(snapshot.filter ?? 'all', snapshot.scopePath);
    if (current.privacyDenied) throw new BrowserFailure('PRIVACY_DENIED');
    if (interactionFromSurface(current).fingerprint !== snapshot.fingerprint)
      throw new BrowserFailure('STALE_TARGET');
    const ref = 'ref' in args ? args.ref : scope?.ref;
    const target = ref
      ? snapshot.targets.find(
          (t) =>
            t.ref === ref && source.snapshot!.targets.some((delivered) => delivered.ref === ref),
        )
      : undefined;
    if (args.operation === 'click' && args.point) {
      if (
        !source.image ||
        !observation.image ||
        source.readiness !== 'ready' ||
        args.point.x >= source.image.width ||
        args.point.y >= source.image.height
      )
        throw new BrowserFailure('STALE_TARGET');
      const x = args.point.x / source.image.scale + source.image.crop.x;
      const y = args.point.y / source.image.scale + source.image.crop.y;
      coordinate = { x, y };
      if (!(await driver.pointAllowed(binding, coordinate, ctx)))
        throw new BrowserFailure('NOT_AUTHORIZED');
    }
    if (scope) {
      if (!target) throw new BrowserFailure('STALE_TARGET');
      scopePath = target.path;
    }
    if (isAction) {
      if (
        args.operation !== 'scroll' &&
        !coordinate &&
        (!target || target.disabled || target.sensitive)
      )
        throw new BrowserFailure('NOT_AUTHORIZED');
      if (args.operation === 'fill' && target?.role !== 'textbox')
        throw new BrowserFailure('NOT_AUTHORIZED');
      state.effect = 'unknown';
      if (args.operation === 'click')
        await driver.act(
          binding,
          {
            operation: 'click',
            ...(coordinate
              ? { point: coordinate }
              : {
                  path: target!.path,
                  dom: target?.activation !== undefined && target.activation !== 'pointer',
                }),
          },
          ctx,
        );
      else if (args.operation === 'fill')
        await driver.act(binding, { operation: 'fill', path: target!.path, text: args.text }, ctx);
      else if (args.operation === 'key')
        await driver.act(binding, { operation: 'key', path: target!.path, key: args.key }, ctx);
      else if (args.operation === 'scroll')
        await driver.act(
          binding,
          { operation: 'scroll', direction: args.direction, pixels: args.pixels },
          ctx,
        );
      await revalidate(undefined, true);
      state.effect = 'applied';
      if ('readiness' in args && args.readiness)
        readiness = await driver.readiness(
          binding,
          args.readiness.text,
          args.readiness.timeoutMs,
          ctx,
        );
    }
  }
  if (args.operation === 'navigate') {
    state.effect = 'unknown';
    await driver.navigate(binding, args.url, ctx);
    await revalidate(undefined, true);
    if (args.readiness)
      readiness = await driver.readiness(
        binding,
        args.readiness.text,
        args.readiness.timeoutMs,
        ctx,
      );
  }
  const capture = browserCaptureSchema.parse(
    await driver.capture(
      binding,
      args.operation === 'get_page_text' ? args.mode : 'article',
      scopePath,
      ctx,
    ),
  );
  if (scopePath) capture.scope = 'snapshot-subtree';
  if (readiness) capture.readiness = readiness;
  await revalidate(capture.url);
  // URL components that resemble credentials are refused rather than altered evidence.
  if (
    Array.from(new URL(capture.url).searchParams.keys()).some((key) =>
      /token|secret|password|api[-_]?key|authorization|^code$/i.test(key),
    )
  )
    throw new BrowserFailure('PRIVACY_DENIED');
  const filter = args.operation === 'read_page' ? args.filter : 'all';
  const observed = await surface(filter, scopePath);
  if (observed.privacyDenied) throw new BrowserFailure('PRIVACY_DENIED');
  const interaction: BrowserInteraction = {
    ...interactionFromSurface(observed),
    filter,
    ...(scopePath ? { scopePath } : {}),
  };
  if (args.operation === 'read_page') {
    const snapshot = {
      snapshot: await driver.accessibility(binding, observed, filter, scopePath, ctx),
    };
    capture.representation = 'accessibility';
    capture.scope = scopePath ? 'snapshot-subtree' : 'owned-tab';
    capture.captureTruncated = true;
    capture.exclusions.push(
      'accessibility depth <=8; use snapshot r refs for actions; CLI refs are not actionable',
    );
    capture.blocks = snapshot.snapshot
      ? [
          {
            id: 'b0',
            kind: 'accessibility',
            text: snapshot.snapshot.replace(/\s*\[ref=e\d+\]/g, ''),
            sectionId: null,
            links: [],
          },
        ]
      : [];
    await revalidate(capture.url);
  }
  let image: BrowserObservation['image'];
  const observationId = (options.newId ?? randomUUID)();
  if (args.operation === 'screenshot') {
    if (
      observed.context.width > BROWSER_LIMITS.imageDimension ||
      observed.context.height > BROWSER_LIMITS.imageDimension
    )
      throw new BrowserFailure('LIMIT_REACHED');
    const painted = await driver.paint(binding, ctx);
    if (painted !== 'ready') {
      capture.readiness = 'partial';
      capture.exclusions.push(
        'paint readiness timed out: pixels may lag the DOM; coordinate actions unavailable',
      );
    }
    const pngBytes = await driver.screenshot(binding, ctx);
    if (pngBytes.length > BROWSER_LIMITS.image) throw new BrowserFailure('LIMIT_REACHED');
    const bytes = Buffer.from(pngBytes);
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== observed.context.width ||
      bytes.readUInt32BE(20) !== observed.context.height
    )
      throw new BrowserFailure('INVALID_OUTPUT');
    const crop = args.crop ?? {
      x: 0,
      y: 0,
      width: observed.context.width,
      height: observed.context.height,
    };
    if (
      crop.x + crop.width > observed.context.width ||
      crop.y + crop.height > observed.context.height
    )
      throw new BrowserFailure('INVALID_ARGUMENTS');
    const png = PNG.sync.read(bytes);
    const cropped = new PNG({ width: crop.width, height: crop.height });
    PNG.bitblt(png, cropped, crop.x, crop.y, crop.width, crop.height, 0, 0);
    const output = PNG.sync.write(cropped);
    if (output.length > BROWSER_LIMITS.image) throw new BrowserFailure('LIMIT_REACHED');
    if (
      interactionFromSurface(await surface(filter, scopePath)).fingerprint !==
      interaction.fingerprint
    )
      throw new BrowserFailure('STALE_TARGET');
    await revalidate(capture.url);
    const uri = `blob://browser/${encodeURIComponent(ctx.sessionId)}/${observationId}.png`;
    if (await options.blobs.getMeta(uri)) throw new BrowserFailure('INVALID_OUTPUT');
    try {
      await options.blobs.put(uri.slice(7), output, { mimeType: 'image/png' });
    } catch {
      throw new BrowserPersistenceFailure();
    }
    image = browserImageSchema.parse({
      uri,
      hash: createHash('sha256').update(output).digest('hex'),
      mimeType: 'image/png',
      bytes: output.length,
      width: crop.width,
      height: crop.height,
      crop,
      scale: 1,
    });
    capture.blocks = [];
    capture.representation = 'accessibility';
    capture.exclusions.push('image only: no canonical text citation authorized');
  }
  if (binding.securityMode === 'trusted-managed')
    capture.exclusions.push(
      'trusted managed browser: private profile; deployment egress/privacy controls not asserted',
    );
  if (binding.securityMode === 'trusted-cdp')
    capture.exclusions.push(
      'trusted CDP: shared cookies; deployment egress/privacy controls not asserted',
    );
  const persisted = await persistCapture(
    capture,
    binding,
    ctx,
    options,
    {
      interaction,
      ...(image ? { image } : {}),
      ...('readiness' in args && args.readiness ? { readinessCondition: args.readiness } : {}),
    },
    observationId,
  );
  if (args.operation === 'navigate') state.effect = 'applied';
  return persisted;
}
