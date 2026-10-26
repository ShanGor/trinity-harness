import {
  browserResultSchema,
  browserErrorSchema,
  researchResultSchema,
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
  let headingOnlySelection = false;
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
      const parsed = browserResultSchema.safeParse(event.value);
      const saved = ['read_observation', 'search_observation'].includes(
        String((call.args as { operation?: unknown } | null)?.operation),
      );
      if (!event.isError && parsed.success) {
        if (!saved && !parsed.data.saved) {
          failures = 0;
          liveAccessDenied = false;
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
        const args = call.args as { operation?: unknown; blockIds?: unknown } | null;
        headingOnlySelection =
          args?.operation === 'read_observation' &&
          Array.isArray(args.blockIds) &&
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
        failures += 1;
        const error = browserErrorSchema.safeParse(event.value);
        if (error.success && ['NOT_AUTHORIZED', 'DISABLED'].includes(error.data.code))
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
  const advice: string[] = actionGuidance(events.slice(promptSeq));
  if (researchAvailable && citationFailures >= 2)
    advice.push(
      "Research citations have been rejected repeatedly. Prefer a delivered browser observation/block/range reference to resolve exact text without retyping. For legacy sources, change the quote, not just the claim: copy a short contiguous passage directly from the observed excerpt, preserving punctuation, or remove the unsupported finding and record the remaining notes. Check that each passage supports its claim. Successful browser reads remain usable. This is recovery advice, not a stop request. The final answer should address the user's question and evidence limits; omit internal research bookkeeping, retry plans, and complaints about the validator.",
    );
  if (researchAvailable && readyToAnswer)
    advice.push(
      'Your research notes mark the evidence ready for answering. Produce the final answer with supported findings, source URLs and explicit uncertainty. Explore further only if you identify a concrete unresolved requirement from the user request.',
    );
  if (liveAccessDenied)
    advice.push(
      'Live browser access was denied or disabled. Changing domains, retrying the same operation, or reading saved evidence does not restore live authorization. Use relevant saved evidence if available and return a useful qualified answer or a focused clarification with the access limitation. Do not delegate live research to work around an unavailable browser.',
    );
  if (failures >= 3)
    advice.push(
      'At least three consecutive browser commands failed or returned empty reads without a successful live operation. Successful saved reads do not demonstrate live recovery. Follow the structured error recovery once; change sources only for a source-specific failure. If access remains unavailable, answer from supported evidence or ask the focused question needed to proceed, explicitly reporting incomplete work. Do not keep testing domains or retrying the same unsuccessful sequence.',
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
  return advice.length ? advice.join('\n') : null;
}
