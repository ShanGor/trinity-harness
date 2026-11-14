# Latest conversation behavior review — 2026-11-10

This document records the session evidence. Use the [consolidated improvement plan](agent-behavior-improvement-plan-2026-11-10.md) for future work, evaluation, and release decisions.

## Scope and result

Read-only review of the complete 416-event session
`01a1c5b2-daaf-7000-a0ad-58c602b57b0e`, the latest conversation at inspection.
The Chinese brief-phone request asked for an HSBC executive named Mario's
background and **country of birth**. Birthplace, citizenship and ancestry are
different questions. This review evaluates the delivered evidence and response;
it does not independently verify the person's biography against the live web.

The run found useful background and correctly left birthplace unconfirmed, but
failed language, brevity, research efficiency and parts of factual grounding.
The previous increment did not establish satisfactory agent behavior.

## Measurements

| Measure                 | Latest run                                    | Previously reviewed run                                      |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| UTC start/end           | 13:43:15–13:48:56                             | 13:05:14–13:15:02                                            |
| Elapsed                 | About 5m41s                                   | About 9m48s                                                  |
| Model requests          | 66                                            | 57                                                           |
| Browser calls           | 66                                            | 55                                                           |
| Searches                | 5 `web_search` plus 29 search-URL navigations | 24 `web_search`; total search-URL navigations not recomputed |
| Recorded model cost     | USD 0.30746346                                | About USD 0.2279058                                          |
| First/last input tokens | 10,024 / 122,907                              | 9,851 / 99,230                                               |
| Tool errors             | 7                                             | 12                                                           |

The latest run spent about 181 seconds in tools and 153 seconds in recorded
model requests. Its final answer contained approximately 243 whitespace-delimited
words and 38 automatic Sources entries. There were no research-note calls, so
the absence of citation-validation errors does not exercise citation recovery.
The prompts and public pages differed; this is not a controlled before/after
quality comparison. Lower elapsed time did not mean better action economy.

## Findings and causes

### 1. Search tracking misses equivalent operations

`progress-guidance.ts` updates discovery only for `operation === 'web_search'`.
The agent performed another 29 searches through `navigate`, predominantly to
DuckDuckGo HTML results. Later variations therefore never updated the discovery
window. The last discovery warning was committed at seq 154, although searching
continued through seq 408. Its earlier warning remained in final model context;
it was stale advice, not a missing-context problem.

The current destination filter also drops same-origin links. DuckDuckGo's
observed result links use same-origin `/l/?uddg=...` redirects, so merely extending
the operation condition would still mismeasure discovery. Its generic repeated
text detector is also defeated by changing query text in "No results" headings.

Proposed fix: derive discovery from validated search-result provenance across
both typed searches and recognized search navigations. Normalize only known
redirect formats for comparison, preserve original URLs/evidence, exclude search
chrome, and count external destination novelty independently of snippets/query
headings. Saved reads must not become new web discovery. Replay, cancellation,
ownership and evidence authority remain unchanged. Test direct versus wrapped
destinations, empty/no-result pages, redirects, fragments and provider switching.

### 2. Supplied instructions are not sufficient to ensure compliance

The running worker's agent-loop, phone-guidance and progress-guidance source
hashes matched the checkout. The first and final private request snapshots
contained language, phone and factual-strength guidance. The final request also
retained the original Chinese prompt and discovery warning. This rules out
missing deployment or simple loss of those instructions as the explanation for
this run; it does not establish provider-internal causes.

Acknowledgment at seq 11 was Chinese. Progress at seq 159 and 316, and the final
at seq 413, were English. At seq 159 the agent said background evidence was
sufficient and only birthplace remained; it then made another 42 browser calls.
At seq 316 it promised one targeted attempt, then made 16 more calls.

Likely contributors are weak instruction adherence, repetitive self-continuation,
English source/history influence and a growing context. These are hypotheses;
the trace cannot isolate their relative effects. Additive prompt wording alone
has already failed here.

Proposed experiment: put a short replayable current-request/delivery/recovery
brief near the next decision, reducing redundant guidance instead of adding more
prose. Compare the same tasks and tools on the current model and a stronger
candidate separately from harness changes. Score all user-visible language,
phone usability, supported completeness and recovery. Optional final-response
review should be separately measured, bounded, read-only and never allowed to
repeat effects; do not introduce an unvalidated reviewer as a truth gate.

### 3. Unsupported expansion and uncertainty drift

The final correctly reported birth country as unestablished. However, it still
suggested South Asian family origins from surname/education, despite explicit
guidance against that inference. Later queries guessed numerous countries without
supporting leads. Calling speculation an inference did not make it useful or
supported. The response also shifted the requested birthplace into nationality
and citizenship.

The LinkedIn post delivered at seq 305 says he departed in November without
stating that November's year. The final assigned November 2023, apparently
borrowing the year from the adjacent compensation sentence. The Stack says he
joined in 2024; a separate 2025 appointment account does not explain that
difference. The final's "2024–2025" compresses a discrepancy rather than resolving
it. Education was explicitly attributed to a search snippet, which was appropriate.

Proposed fix: evaluate answers against claim-to-passage support, preserving
exact requested facts and unresolved date distinctions. Stop speculative country
enumeration when no source motivates it. Prefer a supported partial answer with
the precise gap. Do not infer completion from a checklist, call count or missing
results. Generalize tests beyond biographies and do not hard-code this person.

### 4. Browser evidence and recovery need better diagnostics

Twelve successful results contained no text blocks, including repeated Google
captures. Other successful captures were 403, Cloudflare, access-denied or missing
pages. Transport/capture success is not readable source evidence. Three
screenshots and one scroll returned `STALE_TARGET`; the immediate screenshot
after seq 79 used the latest delivered snapshot, so blaming all failures on
invented identifiers would be incorrect. Existing generic errors cannot identify
which freshness fence failed. The second screenshot did use an older snapshot
after the first failure.

Proposed fix: bounded value-free diagnostics distinguishing missing delivery,
intervening operation, binding/generation/document change and surface mismatch.
Test immediate capture-to-screenshot, dynamic search pages and shared Main/side
browser activity. Preserve all freshness and privacy checks. Use diagnostics to
establish the actual cause before relaxing any behavior. Empty/blocked result
classification should distinguish unavailable evidence from infrastructure
failure, without exposing protected content or attempting bypasses.

Two failed navigations returned the new 30-second deadline (seq 134 and 251),
showing that mechanism operated. It did not fix the search strategy. Do not
conflate a command timeout with end-to-end task readiness or automatically retry
unknown effects.

### 5. Sources are an observation index, not support certification

The final's 38 Sources entries included search pages, access-denied pages and
login walls. Those entries establish observations, not claim support. Retain
execution evidence in history, but consider a separately labeled answer-support
selection containing exact delivered passages. Validate exposure mechanically;
evaluate entailment separately. Do not silently convert Sources into a truth
badge or require unnecessary research-note calls for simple answers.

## Recommended order

1. Fix operation-independent search accounting and redirect normalization; add
   bounded stale-target diagnostics and realistic deterministic regressions.
2. Run repeated, human-reviewed model comparisons with Chinese phone delivery,
   missing facts, conflicting dates, empty search captures and direct search
   navigation. Fixed-page fixtures alone cannot validate live search recovery.
3. Experiment with a concise decision brief and optional final-response review
   separately. Require preserved support/completeness, fewer wasted actions,
   correct language and acceptable latency/cost before rollout claims.
4. Improve Sources presentation separately after clarifying its support contract.

No arbitrary browser-call ceiling or forced-success rule is recommended. Existing
configured budgets can bound cost, but must reserve a truthful final response and
cannot certify semantic completion. No runtime code, services, Git state or paid
model trials were changed by this review.
