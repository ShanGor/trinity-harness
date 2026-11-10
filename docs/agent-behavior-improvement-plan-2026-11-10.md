# Research behavior improvement plan — 2026-11-10

## Evidence and objective

Read-only inspection of session `01a1c590-0d92-7000-b317-b50e19434d34`
covered its complete 358-event log. The Chinese brief-phone request asked for a
CTO's background and nationality. The turn ran from 13:05:14 to 13:15:02 UTC:
57 model requests, 55 browser calls (24 searches), two rejected research-note
calls, 12 tool errors, and approximately USD 0.228 recorded model cost. Input
grew from 9,851 to 99,230 tokens. Two failed searches each took about 102 seconds;
all tool calls together took about 383 seconds. Useful career evidence was
delivered at seq 27, about 14 seconds into the turn; nationality remained
unconfirmed. These are observations from one run, not population estimates or
proof of a model-internal cause. Private conversation text and source bodies are
not copied into fixtures or this document.

The outcome to improve is a timely, supported answer to every requested component,
with honest evidence gaps, coherent recovery and language-appropriate delivery.
Successful termination, a verified checklist, additional searches and fewer
calls do not independently prove that outcome.

## Implementation

| Priority | Failure and change                                                                                                                                                                                                                                                                                                                                          | Acceptance                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Citations mixed an older delivered passage with a newer capture. On structured range/block errors, offer at most four already-delivered, revalidated passages from the same observed URL, preferring the requested block. Include exact observation/block/range references and bounded quotes. Keep the rejection; never substitute evidence automatically. | Wrong-capture rejection, successful correction using an older valid reference, bounded suggestions, previous-turn exclusion and corrupt-artifact rejection. Existing ownership, Unicode, range and replay tests remain required.                                        |
| P0       | Guest MCP permits 100 seconds for startup/transport. Navigation and load-readiness commands now use the smaller of the configured connection deadline and 30 seconds. Startup and other commands retain their allowance.                                                                                                                                    | Both navigation commands use the shorter guest deadline; startup/status retain 100 seconds; expiry cancels and disposes once, preserves unknown-effect reporting and never resends. This is a per-command bound, not an end-to-end SLA.                                 |
| P1       | Query variations return different snippets but repeatedly discover the same destinations. Replay-derived guidance notices three searches with no new external destination URLs in the last four searches.                                                                                                                                                   | Changed snippets and fragments do not hide repeated discovery; genuinely new destinations age out the warning. Guidance survives replay, resets for a new prompt and contains no raw queries/URLs. No quota, forced final or semantic-completion verdict is introduced. |
| P1       | The agent revisited an unavailable URL. Track repeated `PAGE_UNAVAILABLE` navigation targets separately from channel failures.                                                                                                                                                                                                                              | Unrelated page success does not clear target advice; matching successful navigation does. Saved reads do not establish live recovery. Guidance grants no retry authority.                                                                                               |
| P1       | Search controls were unknown, and the label matcher omitted `搜寻`. Recognize native searchboxes/search containers and narrowly identified native text inputs with conventional query names plus a search label. Support simplified/traditional labels and searchbox preflight.                                                                             | Native controls pass extraction/preflight; labels alone on arbitrary fields/buttons remain insufficient. Sensitive, stale, consequential and unknown controls retain protection. Sites without adequate semantics remain unavailable.                                   |
| P1       | The answer strengthened residence/affiliation into nationality, added unsupported ethnic-origin speculation and reconciled unexplained dates. Add general evidence-strength guidance and synthetic biography/data-location cases.                                                                                                                           | Mechanism tests cannot certify semantic compliance. Repeated model trials must preserve unknowns, conflicting dates, source provenance and every requested component. No demographic classifier or automatic semantic gate is added.                                    |
| P1       | Chinese phone requests received English progress and a lengthy report. Preserve language guidance, clarify concise research delivery and updates after long waits, and carry committed phone metadata into the evaluator.                                                                                                                                   | Phone replay/request-authority tests pass. Evaluate Chinese acknowledgment, progress and concise final output on real models. Updates occur at model opportunities; no fabricated heartbeat or translation layer is introduced.                                         |

Implementation stays in existing tools, Loop and private MCP transport. No new
module, table, event type, provider client or permission grant is required. Exact
exposure validation and immutable events remain authoritative. Suggested passages
do not prove that a claim follows from them. Existing Sources metadata remains an
observation index, not claim-level truth certification.

## Behavioral evaluation and release decision

Extend the personal-mode evaluator with `uncertain-biography-phone` and
`research-evidence-gap`. The former uses committed brief-phone metadata; reports
retain it and fingerprint the research/evidence/phone code. Fixtures are synthetic
development cases, not fresh holdouts. Their fixed source adapter does not model
public search, blocked-site recovery or guest latency.

Compare baseline and candidate using identical model/provider, settings, tools,
permissions, fixture state and ceilings. Start with three repeats of uncertain
biographies, conflicting dates, insufficient hosting evidence, blocked sources,
partial captures, multilingual search controls and concise Chinese voice requests.
Add independently prepared holdouts before making a release-quality claim.
Compare stronger models separately; do not change the default model based on one
incident.

Human review scores requested-outcome completeness, factual support, uncertainty,
reference selection, language and spoken usability. Retain failed runs, latency,
requests, repeated targets, citation failures, unique source discovery, token
buckets and costs. Fewer calls count as improvement only when answer quality and
constraints are preserved. Follow [intent-evaluation.md](intent-evaluation.md)
for opt-in execution/reporting; no paid trials run automatically.

## Delivery and remaining limits

Deploy matching server/worker and Browser Runtime application code after checks.
No migration, pinned browser binary change or guest image rebuild is required.
Existing containers do not change with the checkout. Validate fresh multilingual
controls, a real guest navigation timeout, unknown-effect disposal and a complete
Chinese phone research turn before asserting production improvement. The shorter
deadline may reject a slow page that previously completed; measure that tradeoff.
Do not automatically retry or switch drivers after expiry.

Broader compaction changes, claim-aware Sources UI, automatic answer reviewers,
mandatory research plans, cumulative browser caps and model selection remain
separate experiments. This increment does not establish a general semantic quality
gain or a fix for every public website.

Implementation status and verification results belong in
[project-progress.md](project-progress.md); rollout and behavioral gates remain in
[production-checklist.md](production-checklist.md).
