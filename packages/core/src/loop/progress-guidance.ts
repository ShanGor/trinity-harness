import {
  browserResultSchema,
  browserDocumentResultSchema,
  browserErrorSchema,
  researchResultSchema,
  turnGuidanceEventSchema,
  type SessionEvent,
} from '@trinity-harness/contracts';
import { browserCommand } from '../tools/research.js';
import { createHash } from 'node:crypto';
import { recordedEffect } from './task-verification.js';

function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, canonical(value)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex');
}

/** Pure replay projection; hashes and counts never include raw arguments in advice. */
function actionGuidance(events: readonly SessionEvent[]): string[] {
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>();
  const failures = new Map<string, { key: string; failed: boolean }[]>();
  const reads = new Map<string, { result: string; count: number; scope: string; name: string }>();
  for (const event of events) {
    if (event.type === 'message/user' || event.type === 'turn/end') break;
    if (event.type === 'tool/call') calls.set(event.callId, event);
    if (event.type !== 'tool/result') continue;
    const call = calls.get(event.callId);
    if (!call || ['task', 'skill', 'research', 'recall'].includes(call.name)) continue;
    if (call.name === 'browser' && event.isError) {
      const error = browserErrorSchema.safeParse(event.value);
      if (
        error.success &&
        [
          'INVALID_ARGUMENTS',
          'NOT_EXECUTED',
          'PAGE_UNAVAILABLE',
          'PRIVACY_DENIED',
          'STALE_TARGET',
          'LIMIT_REACHED',
          'ARTIFACT_UNAVAILABLE',
        ].includes(error.data.code)
      )
        continue;
    }
    if (
      call.name === 'bash' &&
      browserCommand((call.args as { command?: unknown } | null)?.command)
    )
      continue;
    const effect = recordedEffect(call, event);
    if (effect.kind !== 'read') {
      for (const [key, read] of reads)
        if (effect.scope === 'unknown' || effect.scope === read.scope) reads.delete(key);
    }
    const key = fingerprint({ name: call.name, args: call.args });
    const recent = failures.get(call.name) ?? [];
    const recovered = event.isError ? recent : recent.filter((item) => item.key !== key);
    recovered.push({ key, failed: event.isError });
    failures.set(call.name, recovered.slice(-6));
    if (event.isError) continue;
    if (effect.kind !== 'read' || effect.scope === 'control' || call.name === 'browser') continue;
    const result = fingerprint(event.value);
    const previous = reads.get(key);
    reads.set(key, {
      result,
      count: previous?.result === result ? previous.count + 1 : 1,
      scope: effect.scope,
      name: call.name,
    });
  }
  const advice: string[] = [];
  const failed = [...failures]
    .filter(([, recent]) => recent.filter((item) => item.failed).length >= 2)
    .map(([name]) => name)
    .sort();
  if (failed.length)
    advice.push(
      `Repeated tool failures: ${failed.slice(0, 8).join(', ')}. At least two of the last six recorded calls to each listed tool failed without a subsequent success for those same arguments. Identify the specific failure and remaining user requirement before more probes. Unrelated successful calls do not prove recovery. Reusing different arguments or another tool does not by itself resolve the cause. Do not automatically repeat an unknown effect; reobserve safely first. If a different approach already resolved the issue, use that evidence and continue. Otherwise use a justified recovery, a supported qualified answer, or a focused clarification. These observations do not prove the task is blocked or complete.`,
    );
  const redundant = [
    ...new Set([...reads.values()].filter((read) => read.count >= 3).map((read) => read.name)),
  ].sort();
  if (redundant.length)
    advice.push(
      `Repeated unchanged observations: ${redundant.slice(0, 8).join(', ')}. The same arguments returned the same recorded result at least three times without an intervening recorded effect on that scope. Reuse the delivered evidence. Repeat only to address a concrete remaining question or changed state; otherwise change strategy or answer with the evidence and limits. Repetition alone does not establish completion.`,
    );
  return advice;
}

/** Observations only: repeated output is not a judgment that the task has failed. */
export function progressGuidance(
  events: readonly SessionEvent[],
  promptSeq: number,
  step: number,
  maxSteps: number,
  researchAvailable = false,
): string | null {
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>();
  const seen = new Set<string>();
  let repeated = 0;
  const recentBrowserReads: boolean[] = [];
  const seenBrowserBlocks = new Set<string>();
  const discoveredLinks = new Set<string>();
  const recentDiscovery: boolean[] = [];
  const unavailableTargets = new Set<string>();
  const repeatedUnavailableTargets = new Set<string>();
  let headingOnlySelection = false;
  let extractionGap = false;
  let partialDocumentCapture = false;
  let documentCaptureUnavailable = false;
  let failures = 0;
  let liveAccessDenied = false;
  let readyToAnswer = false;
  let citationFailures = 0;
  for (const event of events.slice(promptSeq)) {
    if (event.type === 'tool/call') calls.set(event.callId, event);
    if (event.type !== 'tool/result') continue;
    const call = calls.get(event.callId);
    if (call?.name === 'research') {
      const value = event.value as { code?: unknown } | null;
      if (event.isError && value?.code === 'RESEARCH_SOURCE_MISMATCH') citationFailures += 1;
    }
    if (call?.name === 'research' && !event.isError) {
      const result = researchResultSchema.safeParse(event.value);
      if (result.success && result.data.promptSeq === promptSeq && result.data.notes) {
        citationFailures = 0;
        readyToAnswer = result.data.notes.readyToAnswer;
      }
    }
    if (call?.name === 'browser') {
      const args = call.args as { operation?: unknown; url?: unknown } | null;
      const parsed = browserResultSchema.safeParse(event.value);
      const documentCapture = browserDocumentResultSchema.safeParse(event.value);
      if (
        !event.isError &&
        documentCapture.success &&
        documentCapture.data.callId === event.callId &&
        documentCapture.data.operation === 'capture_document' &&
        args?.operation === 'capture_document'
      ) {
        partialDocumentCapture = documentCapture.data.coverage === 'partial';
        extractionGap = false;
        documentCaptureUnavailable = false;
        failures = 0;
        liveAccessDenied = false;
        continue;
      }
      const target =
        args?.operation === 'navigate' && typeof args.url === 'string'
          ? fingerprint(args.url)
          : undefined;
      const browserError = browserErrorSchema.safeParse(event.value);
      if (
        target &&
        event.isError &&
        browserError.success &&
        browserError.data.code === 'PAGE_UNAVAILABLE'
      ) {
        if (unavailableTargets.has(target)) repeatedUnavailableTargets.add(target);
        unavailableTargets.add(target);
      } else if (target && !event.isError && parsed.success && !parsed.data.saved) {
        unavailableTargets.delete(target);
        repeatedUnavailableTargets.delete(target);
      }
      const saved = [
        'read_observation',
        'search_observation',
        'extract_capture',
        'read_capture',
        'search_capture',
        'export_capture',
        'export_markdown',
      ].includes(String((call.args as { operation?: unknown } | null)?.operation));
      if (!event.isError && parsed.success) {
        const discovery = parsed.data.discovery;
        // Old events have no adapter metadata. Preserve their original web_search
        // semantics without teaching the loop provider URL or redirect formats.
        if (
          !saved &&
          !parsed.data.saved &&
          parsed.data.callId === event.callId &&
          parsed.data.operation === args?.operation &&
          (discovery || args?.operation === 'web_search')
        ) {
          const links =
            discovery?.destinationKeys ??
            (parsed.data.links ?? []).flatMap((link) => {
              const url = new URL(link.url);
              if (url.origin === new URL(parsed.data.url).origin) return [];
              url.hash = '';
              return [fingerprint(url.href)];
            });
          recentDiscovery.push(links.some((link) => !discoveredLinks.has(link)));
          if (recentDiscovery.length > 4) recentDiscovery.shift();
          for (const link of links) discoveredLinks.add(link);
        }
        if (!saved && !parsed.data.saved) {
          failures = 0;
          liveAccessDenied = false;
        }
        if (
          !saved &&
          !parsed.data.saved &&
          ['navigate', 'get_page_text', 'web_search'].includes(parsed.data.operation)
        ) {
          const extraction = parsed.data.extraction;
          extractionGap = Boolean(
            extraction &&
            (extraction.status !== 'text-captured' ||
              (extraction.unavailableFrames ?? extraction.visibleFrames) ||
              extraction.canvases),
          );
        }
        const blocks = parsed.data.blocks;
        const signatures = blocks.map((block) =>
          JSON.stringify({ kind: block.kind, text: block.text }),
        );
        recentBrowserReads.push(
          signatures.length === 0 ||
            signatures.every((signature) => seenBrowserBlocks.has(signature)),
        );
        if (recentBrowserReads.length > 6) recentBrowserReads.shift();
        for (const signature of signatures) seenBrowserBlocks.add(signature);
        const readArgs = call.args as { operation?: unknown; blockIds?: unknown } | null;
        headingOnlySelection =
          readArgs?.operation === 'read_observation' &&
          Array.isArray(readArgs.blockIds) &&
          blocks.length > 0 &&
          blocks.every((block) => block.kind === 'heading');
        const signature = JSON.stringify(
          blocks.map((block) => ({ kind: block.kind, text: block.text })),
        );
        if (parsed.data.blocks.length === 0 || seen.has(signature)) repeated += 1;
        else {
          repeated = 0;
          seen.add(signature);
        }
      } else if (!saved) {
        const error = browserErrorSchema.safeParse(event.value);
        // A protected page, stale snapshot or rejected arguments do not
        // establish that the live browser channel is unavailable.
        if (
          !error.success ||
          ['DRIVER_FAILED', 'INVALID_OUTPUT', 'TRANSPORT_OVERFLOW', 'CANCELLED'].includes(
            error.data.code,
          )
        )
          failures += 1;
        if (
          error.success &&
          error.data.code === 'DISABLED' &&
          args?.operation === 'capture_document'
        )
          documentCaptureUnavailable = true;
        else if (error.success && ['NOT_AUTHORIZED', 'DISABLED'].includes(error.data.code))
          liveAccessDenied = true;
      }
      continue;
    }
    if (call?.name !== 'bash') continue;
    const command = browserCommand((call.args as { command?: unknown } | null)?.command);
    if (!command) continue;
    const read =
      ['read', 'snapshot'].includes(command.action) ||
      (command.action === 'get' &&
        ['text', 'html', 'attr', 'title', 'url'].includes(command.argv[0] ?? '')) ||
      (command.action === 'eval' &&
        command.argv.some((argument) => argument.includes('trinity-research-page-v1')));
    const value = event.value as { stdout?: unknown; exitCode?: unknown } | null;
    const stdout = typeof value?.stdout === 'string' ? value.stdout.trim() : '';
    if (event.isError || value?.exitCode !== 0 || (read && stdout.length === 0)) {
      failures += 1;
      continue;
    }
    if (['skills', 'session', '--version', '--help'].includes(command.action)) continue;
    failures = 0;
    liveAccessDenied = false;
    if (!read) {
      // A navigation/action invalidates observations from the previous page state.
      seen.clear();
      repeated = 0;
      continue;
    }
    const signature = stdout
      .replace(/\[ref=e\d+\]|@e\d+/g, '@ref')
      .replace(/\s+/g, ' ')
      .trim();
    if (seen.has(signature)) repeated += 1;
    else {
      seen.add(signature);
      repeated = 0;
    }
  }
  const advice: string[] = [];
  if (documentCaptureUnavailable)
    advice.push(
      'Rendered document capture is unavailable on the installed build. This does not disable ordinary live navigation or semantic reads. Use supported saved/live evidence and report the precise extraction limit; do not retry capture or switch drivers.',
    );
  if (partialDocumentCapture)
    advice.push(
      'Rendered document capture has explicit omitted or limited scopes. Convert and read available saved documents offline; conversion errors do not require recapture. Media gaps do not invalidate text evidence. Do not repeat unchanged capture, reload, or replay input to repair coverage. Preserve the unresolved user requirement and report the specific document/media limit when it cannot be retrieved. This is recovery advice, not proof of completion.',
    );
  if (extractionGap && !documentCaptureUnavailable)
    advice.push(
      'Browser extraction has limited top-document coverage. This is not evidence that navigation failed. Reuse the existing page; inspect one fresh screenshot or read_page if needed to distinguish loading from an extraction boundary. When capture_document is advertised, use one rendered document capture for unresolved frame/extraction gaps, then extract_capture/read_capture offline. Export requires the exact captureId from that successful capture, never an observationId or snapshotId. If capture_document is absent and no authorized saved rendered capture exists, a new HTML/media export is unavailable: report the deployment capability gap instead of probing saved operations or transcribing scrolling screenshots as a complete export. Unresolved frames, closed shadow roots and canvas text require supported browser capabilities; do not guess their contents or endpoints. Do not reopen the same rendered page, repeat unchanged extraction, or switch to curl/shell HTTP or view-source as an extraction workaround. If the advertised operations cannot retrieve the missing content, report the precise limitation and do not claim a complete export.',
    );
  if (repeatedUnavailableTargets.size)
    advice.push(
      'A navigation repeated a target already reported PAGE_UNAVAILABLE in this turn. Changing unrelated arguments or succeeding on another page does not establish that target recovered. Do not automatically retry it again; use delivered evidence or a different relevant source unless fresh evidence establishes recovery. This is source-specific advice, not a browser-wide outage.',
    );
  if (recentDiscovery.length === 4 && recentDiscovery.filter((novel) => !novel).length >= 3)
    advice.push(
      'At least three of the last four search observations delivered no new destination URLs beyond earlier search results. Equivalent browser operations share this discovery history. Partial captures and link limits can omit destinations; this does not prove the question is answered or the snippets are complete. Identify the unresolved user requirement and a plausible new source before another query variation; read relevant discovered sources or provide supported findings with explicit uncertainty when further discovery is unlikely to change the answer. Do not infer a fact from missing search results. This is strategy advice, not a tool limit or stop rule.',
    );
  if (researchAvailable && citationFailures >= 2)
    advice.push(
      "Research citations have been rejected repeatedly. Prefer a delivered browser observation/block/range reference to resolve exact text without retyping. For legacy sources, change the quote, not just the claim: copy a short contiguous passage directly from the observed excerpt, preserving punctuation, or remove the unsupported finding and record the remaining notes. Check that each passage supports its claim. Successful browser reads remain usable. Notes are optional: when those reads support the requested answer, answer without a successful note record. Do not collect sources solely to make notes validate. This is recovery advice, not a stop request. The final answer should address the user's question and evidence limits; omit internal research bookkeeping, retry plans, and complaints about the validator.",
    );
  if (researchAvailable && readyToAnswer)
    advice.push(
      'Your research notes mark the evidence ready for answering. Readiness and findings are model-authored. Reference validation checks delivered passages, not whether claims follow from them. Check the claims against those passages, preserve unsupported details as unknown, and answer the current request with source URLs and explicit uncertainty. Explore further only for a concrete unresolved requirement from the user request.',
    );
  if (liveAccessDenied)
    advice.unshift(
      'Live browser access was denied or disabled. Changing domains, retrying the same operation, or reading saved evidence does not restore live authorization. Use relevant saved evidence if available and return a useful qualified answer or a focused clarification with the access limitation. Do not delegate live research to work around an unavailable browser.',
    );
  if (failures >= 3)
    advice.unshift(
      'At least three browser channel failures or empty reads occurred without a successful live operation. Successful saved reads do not demonstrate live recovery. Follow the structured error recovery once; change sources only for a source-specific failure. If access remains unavailable, answer from supported evidence or ask the focused question needed to proceed, explicitly reporting incomplete work. Do not keep testing domains or retrying the same unsuccessful sequence.',
    );
  if (headingOnlySelection)
    advice.push(
      'The last saved read selected only heading blocks. blockIds returns exactly those blocks, not the content below them. Read the relevant sectionId or start a cursor at its heading without blockIds to include following content. This result does not establish that the page body is missing. Read only what the user question needs.',
    );
  if (recentBrowserReads.filter(Boolean).length >= 3 && repeated < 3)
    advice.push(
      'At least three of the last six browser reads returned empty or previously delivered block text, interspersed with other reads. Changing URLs or block groupings does not by itself add evidence. Identify the remaining user requirement and change the reading strategy or source; use saved sections, observed links or a relevant screenshot. If the evidence supports a qualified answer, provide it. This is strategy advice, not a completion or stop rule.',
    );
  if (repeated >= 3)
    advice.push(
      'The last three browser reads repeated output already observed on this page. This does not prove the task is blocked. Use article text and actual link URLs, follow a source that addresses the remaining question, or conclude with supported findings and explicit uncertainty.',
    );
  if (Number.isFinite(maxSteps) && step >= Math.ceil(maxSteps * 0.75))
    advice.push(
      'The turn is in its final quarter of the step budget. Prioritize unresolved requirements, avoid redundant exploration, and prepare a useful final answer with sources and limitations. The final step is reserved for answering.',
    );
  advice.push(...actionGuidance(events.slice(promptSeq)));
  // The event contract bounds the combined text, not each individual warning.
  // Keep complete messages in priority order; generic repetition is lowest priority.
  const limit = turnGuidanceEventSchema.shape.advice.maxLength!;
  let bounded = '';
  for (const message of advice) {
    const candidate = bounded ? `${bounded}\n${message}` : message;
    if (candidate.length <= limit) bounded = candidate;
  }
  return bounded || null;
}
