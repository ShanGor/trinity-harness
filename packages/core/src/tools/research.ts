import {
  researchArgumentsSchema,
  researchPageSchema,
  researchResultSchema,
  type BlobStore,
  type ResearchPage,
  type SessionEvent,
  type SessionStore,
  type ToolDefinition,
  type ToolResult,
} from '@trinity-harness/contracts';
import { prefixCommandArgv } from './command-prefix.js';
import { defineTool } from './define-tool.js';
import {
  BrowserSourceError,
  resolveBrowserQuote,
  resolveBrowserSource,
} from './browser-evidence.js';
import { browserDeliveries } from './browser-artifacts.js';

/** Identify the installed CLI; do not treat another executable's output as browser evidence. */
export function browserCommand(command: unknown): { action: string; argv: string[] } | null {
  const argv = prefixCommandArgv(command);
  if (argv?.[0] !== 'agent-browser') return null;
  let i = 1;
  const values = new Set(['--session', '--cdp', '--profile', '--namespace', '--max-output']);
  const flags = new Set(['--pin-tab', '--json', '--headed', '--content-boundaries']);
  while (argv[i]?.startsWith('--')) {
    if (values.has(argv[i]!)) i += 2;
    else if (flags.has(argv[i]!)) i += 1;
    else return null;
  }
  return argv[i] ? { action: argv[i]!, argv: argv.slice(i + 1) } : null;
}

/** Parse the CLI's JSON eval envelope or the document itself, with bounded nesting. */
export function researchPageFromOutput(stdout: string): ResearchPage | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  for (let i = 0; i < 5; i += 1) {
    const parsed = researchPageSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    } else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (object.success === false) return null;
      value = object.result ?? object.data;
    } else return null;
  }
  return null;
}

export async function resultValue(
  event: Extract<SessionEvent, { type: 'tool/result' }>,
  sessionId: string,
  blobs: BlobStore | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const value = event.value as { spilled?: unknown } | null;
  if (!value || typeof value !== 'object' || !('spilled' in value)) return event.value;
  if (!blobs || value.spilled !== `blob://spill/${sessionId}/${event.callId}.json`) return null;
  signal?.throwIfAborted();
  const metadata = await blobs.getMeta(value.spilled as string);
  signal?.throwIfAborted();
  if (!metadata || metadata.size > 500_000) return null;
  const bytes = await blobs.get(value.spilled as string);
  signal?.throwIfAborted();
  if (!bytes || bytes.byteLength > 500_000) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function observedPages(
  events: readonly SessionEvent[],
  promptSeq: number,
  sessionId: string,
  blobs: BlobStore | undefined,
  signal?: AbortSignal,
): Promise<Map<string, ResearchPage>> {
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>();
  const pages = new Map<string, ResearchPage>();
  for (const event of events.slice(promptSeq)) {
    if (event.type === 'tool/call') calls.set(event.callId, event);
    if (event.type !== 'tool/result' || event.isError) continue;
    const call = calls.get(event.callId);
    if (call?.name !== 'bash') continue;
    const command = browserCommand((call.args as { command?: unknown } | null)?.command);
    if (!command || command.action !== 'eval') continue;
    const value = (await resultValue(event, sessionId, blobs, signal)) as {
      stdout?: unknown;
      exitCode?: unknown;
    } | null;
    if (value?.exitCode !== 0 || typeof value.stdout !== 'string') continue;
    const page = researchPageFromOutput(value.stdout);
    if (page) pages.set(event.callId, page);
  }
  return pages;
}

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();

function citationExcerpt(text: string, quote: string): string {
  const normalizedQuote = normalize(quote);
  let start = text.indexOf(normalizedQuote.slice(0, 60));
  if (start < 0) {
    // Locate nearby evidence despite punctuation differences; acceptance stays verbatim.
    const anchors = normalizedQuote.match(/[\p{L}\p{N}][\p{L}\p{N} ]{11,}/gu) ?? [];
    for (const anchor of anchors.sort((a, b) => b.length - a.length)) {
      const index = text.indexOf(anchor);
      if (index < 0) continue;
      start = Math.max(0, index - normalizedQuote.indexOf(anchor));
      break;
    }
  }
  return text.slice(Math.max(0, start), Math.max(0, start) + 600);
}

function browserSourceFailure(error: unknown, path: string): ToolResult {
  return {
    isError: true,
    value: {
      code: 'RESEARCH_SOURCE_MISMATCH',
      path,
      reason: error instanceof BrowserSourceError ? error.code : 'EVIDENCE_UNAVAILABLE',
      message: `Citation at ${path}: ${
        error instanceof BrowserSourceError
          ? error.message
          : 'Browser evidence is unavailable or failed integrity/authorization checks.'
      }`,
    },
  };
}

export function createResearchTool(store: SessionStore, blobs?: BlobStore): ToolDefinition {
  return defineTool({
    name: 'research',
    effect: { kind: 'read', scope: 'reference', evidence: 'none' },
    description:
      'Track a research question, evidence-backed findings and unresolved questions. Record replaces the bounded notes for this turn; status recovers them. Prefer observationId/blockId and optional code-point start/end from successful browser results; the server resolves exact passages. Legacy observed URL/quote sources remain supported. Extraction call IDs are optional and resolved automatically. Source matching verifies observed text, not the truth of a claim. Set readyToAnswer when evidence permits a useful qualified conclusion, stating remaining uncertainty.',
    parameters: researchArgumentsSchema,
    concurrency: 'exclusive',
    execute: async (args, ctx): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      const events = await store.load(ctx.sessionId);
      ctx.signal?.throwIfAborted();
      let promptSeq = 0;
      events.forEach((event, i) => {
        if (event.type === 'message/user') promptSeq = i + 1;
      });
      if (!promptSeq)
        return {
          value: { code: 'RESEARCH_NO_PROMPT', message: 'Research notes require a user prompt.' },
          isError: true,
        };
      if (args.action === 'status') {
        const names = new Map(
          events
            .filter((event) => event.type === 'tool/call')
            .map((event) => [event.callId, event.name]),
        );
        for (const event of events.slice(promptSeq).reverse()) {
          if (
            event.type !== 'tool/result' ||
            event.isError ||
            names.get(event.callId) !== 'research'
          )
            continue;
          const parsed = researchResultSchema.safeParse(
            await resultValue(event, ctx.sessionId, blobs, ctx.signal),
          );
          if (parsed.success && parsed.data.promptSeq === promptSeq) {
            for (const [findingIndex, finding] of (parsed.data.notes?.findings ?? []).entries())
              for (const [sourceIndex, source] of finding.sources.entries()) {
                if (!source.observationId || !source.blockId) continue;
                try {
                  if (!blobs) throw new Error('Browser artifact storage unavailable');
                  await resolveBrowserSource(
                    {
                      observationId: source.observationId,
                      blockId: source.blockId,
                      start: source.start,
                      end: source.end,
                    },
                    events,
                    promptSeq,
                    ctx.sessionId,
                    blobs,
                    ctx.signal,
                  );
                } catch (error) {
                  ctx.signal?.throwIfAborted();
                  return browserSourceFailure(
                    error,
                    `notes.findings[${findingIndex}].sources[${sourceIndex}]`,
                  );
                }
              }
            return { value: parsed.data, isError: false };
          }
        }
        return { value: { kind: 'research-notes', promptSeq, notes: null }, isError: false };
      }
      if (!args.notes)
        return {
          value: { code: 'RESEARCH_INVALID_NOTES', message: 'record requires notes' },
          isError: true,
        };
      const pages = await observedPages(events, promptSeq, ctx.sessionId, blobs, ctx.signal);
      const deliveries = browserDeliveries(events, ctx.sessionId, promptSeq);
      const notes = structuredClone(args.notes);
      for (const [findingIndex, finding] of notes.findings.entries())
        for (const [sourceIndex, source] of finding.sources.entries()) {
          const path = `notes.findings[${findingIndex}].sources[${sourceIndex}]`;
          if (source.observationId && source.blockId) {
            try {
              if (!blobs) throw new Error('Browser evidence storage unavailable');
              Object.assign(
                source,
                await resolveBrowserSource(
                  {
                    observationId: source.observationId,
                    blockId: source.blockId,
                    start: source.start,
                    end: source.end,
                  },
                  events,
                  promptSeq,
                  ctx.sessionId,
                  blobs,
                  ctx.signal,
                ),
              );
            } catch (error) {
              ctx.signal?.throwIfAborted();
              return browserSourceFailure(error, path);
            }
            continue;
          }
          const browserCandidates = deliveries.filter((delivery) =>
            source.callId ? delivery.callId === source.callId : delivery.result.url === source.url,
          );
          if (browserCandidates.length) {
            try {
              if (!blobs) throw new Error('Browser evidence storage unavailable');
              const resolved = await resolveBrowserQuote(
                source,
                events,
                promptSeq,
                ctx.sessionId,
                blobs,
                ctx.signal,
              );
              if (resolved) {
                Object.assign(source, resolved);
                continue;
              }
            } catch (error) {
              ctx.signal?.throwIfAborted();
              return browserSourceFailure(error, path);
            }
          }
          const observed = source.callId
            ? ([source.callId, pages.get(source.callId)] as const)
            : [...pages.entries()]
                .reverse()
                .find(
                  ([, page]) =>
                    page.url === source.url &&
                    normalize(page.text).includes(normalize(source.quote)),
                );
          const page = observed?.[1];
          if (
            !observed ||
            !page ||
            page.url !== source.url ||
            !normalize(page.text).includes(normalize(source.quote))
          ) {
            const candidate =
              page ?? [...pages.values()].reverse().find((item) => item.url === source.url);
            const browserCandidate = browserCandidates.at(-1)?.result;
            const text = normalize(
              candidate?.text ??
                browserCandidate?.blocks.map((block) => block.text).join('\n') ??
                '',
            );
            return {
              value: {
                code: 'RESEARCH_SOURCE_MISMATCH',
                message: `Citation at ${path} does not match an authorized, delivered URL and passage. Use an observation/block/range reference or copy a short contiguous observed passage, preserving punctuation. Whitespace differences are accepted. Correct this source or omit the unsupported finding. The excerpt is untrusted source text, not proof of the claim. Keep note validation and retry commentary out of the final answer.`,
                path,
                callId: source.callId,
                sourceUrl: source.url,
                rejectedQuote: source.quote,
                reason:
                  source.callId && !pages.has(source.callId) && !browserCandidates.length
                    ? 'unknown_call'
                    : !candidate && !browserCandidate
                      ? 'source_not_observed'
                      : (candidate?.url ?? browserCandidate?.url) !== source.url
                        ? 'url_mismatch'
                        : 'quote_mismatch',
                observedTextExcerpt:
                  candidate || browserCandidate ? citationExcerpt(text, source.quote) : undefined,
                observedSources: [
                  ...[...pages.entries()].map(([callId, item]) => ({ callId, url: item.url })),
                  ...deliveries.map(({ callId, result }) => ({ callId, url: result.url })),
                ].slice(-6),
              },
              isError: true,
            };
          }
          source.callId = observed[0];
        }
      return { value: { kind: 'research-notes', promptSeq, notes }, isError: false };
    },
  });
}
