import {
  browserResultSchema,
  researchResultSchema,
  type SessionEvent,
} from '@trinity-harness/contracts';
import { browserCommand, researchPageFromOutput } from '../tools/research.js';

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
  let failures = 0;
  const pages = new Set<string>();
  const pagesSinceNotes = new Set<string>();
  let researchRecorded = false;
  let readyToAnswer = false;
  let citationFailures = 0;
  let focusedReadAdvice: string | null = null;
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
        researchRecorded = result.data.notes.findings.length > 0;
        readyToAnswer = result.data.notes.readyToAnswer;
        if (researchRecorded) pagesSinceNotes.clear();
      }
    }
    if (call?.name === 'browser') {
      const parsed = browserResultSchema.safeParse(event.value);
      if (!event.isError && parsed.success) {
        failures = 0;
        pages.add(parsed.data.url);
        pagesSinceNotes.add(parsed.data.url);
        const signature = JSON.stringify(
          parsed.data.blocks.map((block) => ({ kind: block.kind, text: block.text })),
        );
        if (parsed.data.blocks.length === 0 || seen.has(signature)) repeated += 1;
        else {
          repeated = 0;
          seen.add(signature);
        }
        focusedReadAdvice =
          parsed.data.outputTruncated && parsed.data.continuation
            ? `The browser overview is incomplete. Continue the saved observation with ${JSON.stringify({ operation: 'read_observation', observationId: parsed.data.observationId, cursor: parsed.data.continuation })}, or use search_observation with a literal term for the missing claim. get_page_text creates a fresh capture and repeats the beginning; it does not paginate. A saved artifact may contain unexposed evidence, but only delivered ranges can be cited.`
            : null;
      } else failures += 1;
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
    failures = 0;
    const page = command.action === 'eval' ? researchPageFromOutput(stdout) : null;
    if (page) {
      pages.add(page.url);
      pagesSinceNotes.add(page.url);
    }
    if (!read) {
      // A navigation/action invalidates observations from the previous page state.
      if (!['skills', 'session', '--version', '--help'].includes(command.action)) {
        seen.clear();
        repeated = 0;
      }
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
  if (focusedReadAdvice) advice.push(focusedReadAdvice);
  if (researchAvailable && citationFailures >= 2)
    advice.push(
      "Research citations have been rejected repeatedly. Prefer a delivered browser observation/block/range reference to resolve exact text without retyping. For legacy sources, change the quote, not just the claim: copy a short contiguous passage directly from the observed excerpt, preserving punctuation, or remove the unsupported finding and record the remaining notes. Check that each passage supports its claim. Successful browser reads remain usable. This is recovery advice, not a stop request. The final answer should address the user's question and evidence limits; omit internal research bookkeeping, retry plans, and complaints about the validator.",
    );
  if (researchAvailable && pages.size >= 2 && !researchRecorded)
    advice.push(
      'Evidence checkpoint: you have collected multiple article extracts. Before expanding the search, use research to state the exact user question, record source-backed findings and identify remaining gaps. Preserve the requested feature and product surface: general protocol/tool integration, app distribution, and rendering an interactive app UI are different claims. A useful qualified answer is better than continuing unrelated searches.',
    );
  if (researchAvailable && readyToAnswer)
    advice.push(
      'Your research notes mark the evidence ready for answering. Produce the final answer with supported findings, source URLs and explicit uncertainty. Explore further only if you identify a concrete unresolved requirement from the user request.',
    );
  else if (researchAvailable && researchRecorded && pagesSinceNotes.size >= 2)
    advice.push(
      'Evidence checkpoint: you have extracted at least two more sources since recording your research notes. Update the findings and reassess each remaining question before expanding the search. Identify a specific missing claim and a source likely to resolve it; otherwise conclude with supported findings and explicit uncertainty. Repeatedly failing to find a roadmap announcement cannot establish that no plans exist.',
    );
  if (failures >= 3)
    advice.push(
      'At least three consecutive browser commands failed or returned empty reads. Inspect the failure once, then change the source or reading method. Report access/evidence limits if unresolved; do not repeat the same unsuccessful sequence.',
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
