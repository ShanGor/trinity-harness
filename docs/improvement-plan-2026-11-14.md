# Export, verification and workspace approval improvement plan — 2026-11-14

Status: implementation complete for the scoped repairs, with acceptance limits recorded in section 7. This document consolidates the session review and subsequent discussion. The user subsequently authorized implementation; deployment and Git operations are outside that authorization. Implementation status and release evidence belong in [project-progress.md](project-progress.md) and [production-checklist.md](production-checklist.md).

## 1. Objective

Complete browser-to-Markdown requests with useful content checks and fewer redundant calls or approval prompts. Preserve authorization, privacy, source provenance, bounded conversion and honest coverage reporting.

Successful export should provide sufficient evidence of its mechanical result. Additional model-directed verification should address a specific unresolved requirement or warning. Repeating capture, export or file replacement solely to repair verification bookkeeping is unacceptable.

This plan follows [design.md](design.md), [approval-strategy.md](approval-strategy.md), [browser-tool-design.md](browser-tool-design.md) and [intent-execution-design.md](intent-execution-design.md). It refines their existing principles; it does not introduce a workflow engine, plugin framework, new rollout flag or separate LLM quality gate.

## 2. Evidence and limits of the review

Reviewed session: `01a1da40-1869-7000-a26b-79c31a4ad9cb`.

The user requested, in Chinese, that the browser open `https://twin1-ai-product-deep-dive-and-lessons-4feg.pages.grok.bot/` and save its text and images as a complete Markdown file. The initial review followed execution through event 296, while the turn was still active. This is an execution snapshot, not a claim about its eventual terminal result.

| Events  | Observed behavior                                                                                                      | Assessment                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 19–31   | Navigation, minimal plan and rendered capture; two documents, 45 captured resources, zero unavailable resources        | Appropriate initial work                                                                                |
| 38–39   | First successful Markdown export; `warnings: true`, `coverage: unverified`                                             | A deliverable already existed; warnings required interpretation                                         |
| 45–144  | Manifest/file inspection and shell checks for media, size, headings and image references; several unsupported commands | Initial inspection was useful; repeated checks had diminishing value                                    |
| 150–153 | Markdown copied to a workspace-root filename                                                                           | Optional convenience added an effect and approval work                                                  |
| 166–167 | A Markdown sample contained concatenated table-like text, including `AreaWhat Twin1 claimsCertifications...`           | A concrete fidelity concern worth investigating                                                         |
| 173–216 | More status, screenshot, SVG, hash and size checks                                                                     | The important unresolved issue was content fidelity, not another count                                  |
| 222–224 | Image check revised from separate media files to inline SVG; eligible evidence became empty                            | An implementation assumption in the plan created recovery work                                          |
| 237–245 | Second capture and export                                                                                              | Both exports reported the same conversion input hash; no identified content change justified repetition |
| 251–282 | More reads, counts, a rejected comparison and another copy over the existing root file                                 | Repeated work introduced another approval and effect                                                    |
| 288–296 | Empty eligible evidence and rejected verification of the second capture                                                | Verification recovery remained unresolved                                                               |

Both exports reported input hash `d37961fe860f64895b36894cb70cc4c50a0faa61004c2840ec24de5adc8332e1`. Their Markdown files were reported as 544 lines and 221,644 bytes. These observations support redundancy of the second conversion; equal input hashes or file sizes alone do not certify complete coverage or readable output.

Task status also offered a screenshot as eligible evidence for a check requiring successful rendered capture and a capture ID. Eligibility was too broad to establish that particular property. The model's first visible acknowledgment was English despite the Chinese request.

The initial review checkout supported the following baseline implementation observations. The running deployment's exact code revision was not established, so these are not a complete causal diagnosis of the recorded session:

- `packages/core/src/tools/builtin.ts` treats literal `cp` as potentially replacing content and asks without first distinguishing a new destination. Unrecognized shell composition returns no-effect inspection guidance.
- `packages/core/src/loop/task-verification.ts` has legacy and evidence-version-2 paths. Unknown effects and revision boundaries can invalidate receipts. Changes to the plan's overall interpretation can advance boundaries for otherwise unchanged checks.
- `packages/core/src/tools/browser-document-export.ts` already materializes HTML/media, reads saved HTML through Sandbox, checks input integrity, converts offline and records output provenance. Its short result exposes a warning boolean and input hash; richer details require inspecting the manifest.
- `packages/core/src/tools/browser-html-markdown.ts` currently warns for inline SVG and unsupported tables. A warning therefore need not indicate missing content or failed conversion.

## 3. What “workflow” means here

There are three distinct mechanisms:

| Mechanism                   | Current responsibility                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model guidance              | `skills/agent-browser/SKILL.md` and tool descriptions recommend `navigate → capture_document → export_markdown(captureId)` and inspection of limitations. The model selects each call and any extra work.                                                       |
| Enforced prerequisites      | Tools validate capture IDs, committed source authority, capabilities, permissions and source availability. Semantic observations and screenshots cannot substitute for a rendered capture. A saved authorized capture can be exported without fresh navigation. |
| Implemented export pipeline | Inside `export_markdown`, code saves HTML/media, reads and verifies saved conversion input, runs bounded offline Turndown/GFM conversion and publishes Markdown/provenance.                                                                                     |

The end-to-end task is an LLM-directed sequence of tools. There is no controller automatically advancing navigation, capture, quality review and delivery. Repeated shell checks, plan revisions, recaptures and copies are not required export stages. Improvement should strengthen existing tool results and evidence handling rather than assume or add a workflow engine.

## 4. Proposed changes

### P0 — Make successful export results useful verification evidence

Extend the existing bounded export result and replayable contracts to expose mechanical completion evidence: capture identity, bundle/Markdown paths, input/output hashes, output size, converter provenance and publication success. Reuse data already computed by the exporter. Return success only after required output/provenance writes and final authorization checks succeed; partial bundles remain explicit failures or partial outcomes.

Allow task checks for capture creation and export publication to bind to the corresponding successful tool result. Do not require `wc`, `glob`, `ls`, a copied file or another export to establish facts the tool already guarantees. Keep effect classification and evidence value separate: a workspace mutation can return evidence of its own completed output.

Mechanical receipts establish specific operations and artifacts. They do not certify semantic completeness, readability, graphic rendering or suitability for the user's request. Preserve internal hash, ownership, suppression, cancellation and conversion-limit checks.

Acceptance:

- A capture check binds to a successful `capture_document` receipt; a screenshot cannot satisfy that check merely because both use the browser.
- An export check binds to the successful export's exact capture and output artifacts.
- Failed, cancelled, partial or unauthorized exports cannot produce successful completion receipts.
- Replaying committed events reconstructs the same receipts without repeating effects.

### P0 — Make evidence validity follow the affected artifact and check

Trace the reported empty-evidence behavior against the deployed revision before changing it. Distinguish legacy boundaries, check revisions, global interpretation changes, export effects and shell effects in regression fixtures.

Preserve unchanged check receipts when their meaning and dependencies remain valid. A revision from “separate image files” to “graphics preserved” requires reconsidering the graphics check; it should not automatically erase an unchanged capture or publication check. Consequential changes to the requested outcome or shared assumptions must still invalidate affected checks.

Use adapter-owned resource identities for known operations. A copy changes its resolved destination; it does not modify its source capture or original export. Keep immutable capture validity separate from live browser state and current workspace-file validity. Unknown programs retain conservative handling until their effects are established; the model cannot declare them harmless.

Expose bounded invalidation diagnostics: check ID/revision, rejected receipt sequence, invalidating effect sequence, reason code and the smallest relevant repair. Do not expose file contents or raw sensitive arguments. Never recommend a repeat mutation just to obtain a newer receipt.

Acceptance:

- Copying a Markdown file does not invalidate an immutable capture receipt.
- Replacing a destination invalidates checks for that destination, while unrelated artifacts retain valid evidence.
- Revising only the graphics check preserves dependency-valid capture/publication receipts.
- Status and verification use the same eligibility projection and explain rejected evidence consistently.
- Unknown effects, changed authorization and torn-tail replay remain conservative and deterministic.

### P0 — Automatically allow ordinary reads and safe new workspace copies

The user-confirmed policy is that routine workspace navigation/listing and copies to new destinations within the same workspace should proceed automatically, subject to explicit restrictions and sensitive-file rules.

Recognized literal `ls` already proceeds as a read. A standalone workspace `cd` is harmless, but `cd … && …` requires establishing the effects of the following operation as well. Prefer relative paths and independent bounded reads. Do not blanket-allow shell composition to remove these prompts. Broader syntax support should be added only for a concrete requirement with an equally bounded parser.

For copying, extend existing Sandbox/file mechanisms with a narrowly defined operation whose source, resolved destination and no-replacement behavior can be established. Whether exposed through a file tool or recognized literal command, it must enforce the same semantics. Do not automatically approve arbitrary `cp` flags, recursive copies, multiple sources, special files or uncertain directory-destination expansion under the simple-copy rule.

| Case                                                                      | Proposed default                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Ordinary source and new destination contained in the authorized workspace | Allow without an approval prompt; create the destination exclusively                         |
| Destination already exists                                                | Require applicable current overwrite authority or named-file approval; no silent replacement |
| Destination appears after preflight                                       | Fail without replacement; do not silently escalate or retry                                  |
| Sensitive source or explicitly denied/ask-restricted operation            | Preserve the existing restriction                                                            |
| Escaping paths, symlinks, unsupported copy modes or ambiguous ownership   | Reject or use the applicable inspected approval path; do not apply automatic allowance       |

An existence probe followed by ordinary `cp` is insufficient because another process can create the destination between those steps. Enforce exclusive creation at execution and protect path resolution/containment against symlink races using the applicable Sandbox guarantees. Check both source and actual destination, not just the textual destination folder. Preserve cancellation, bounded transfers and safe reporting of partially created output; never remove unrelated content during cleanup.

The first session copy should not need approval if these conditions are established. The second copy overwrote an existing file and does not qualify for this automatic rule. Do not infer overwrite authority from the model's claim that the operation is harmless.

Acceptance:

- A simple new workspace copy requires zero approval prompts and records a destination-scoped effect.
- Existing files, directory targets, symlink escapes, sensitive sources, explicit restrictions and a raced-in destination cannot be silently replaced or bypassed.
- Local and configured remote Sandbox routes enforce equivalent semantics; no local fallback or raw worker subprocess bypass is introduced.

### P1 — Return actionable export limitations

Replace the warning boolean as the only short explanation with a bounded typed summary. Preserve compatibility with historical results and manifests. Report available categories/counts for omitted or inaccessible frames, truncation, unavailable media, inline SVG, unsupported tables and renderer compatibility concerns. Distinguish informational representation choices from fidelity risks and missing content.

An empty `media/` directory can be expected when all captured graphics are inline SVG. It is not a reason to repeat capture or infer failure. Likewise, zero unavailable captured resources does not prove that every live-page visual was captured. Keep coverage qualified without treating `coverage: unverified` as a perpetual instruction to perform more calls.

Acceptance: the normal result explains whether a warning requires targeted investigation, reporting a limitation, or no additional action. The model need not page through an entire manifest just to discover inline SVG counts or known omissions.

### P1 — Investigate actual content fidelity

Reproduce the concatenated table-like output against the saved HTML and structure, then isolate whether loss occurs in capture, HTML serialization or conversion. Do not attribute it to Turndown without comparing those stages. Use a deterministic fixture for the established cause; preserve explicit unsupported-table representation where applicable.

Check representative body text, a complex table and graphics when relevant. Inline SVG preservation proves markup retention, not rendering in every Markdown viewer. Document supported representations and provide the HTML bundle as a fidelity fallback. Do not promise universal viewer compatibility or convert graphics through unapproved external fetches.

Define checks around the user's outcome: text readable, graphics retained with known limitations, and usable delivery paths. Do not require separate raster files when the page uses SVG. Keep source mappings and automatic research citations distinct from Markdown rendering.

### P1 — Reduce unnecessary model recovery and delivery work

Update the existing skill/tool guidance after receipt and diagnostic changes are available:

1. Use navigation and rendered capture when a new live capture is required.
2. Export the authorized capture once.
3. Inspect the structured limitations and a targeted content sample when a material uncertainty remains.
4. Deliver the Markdown and bundle paths with precise remaining limitations.

This remains guidance, not a rigid call-count gate. A specific loading, content-change or fidelity issue can justify more work. Repeated checks of unchanged artifacts need a reason tied to an unresolved user requirement. A bookkeeping rejection alone does not justify recapturing, exporting or overwriting again.

Deliver the original bundle paths by default; do not copy to the workspace root solely for presentation. Keeping Markdown with its bundle also preserves relative media links. If a separate named deliverable is requested, use the safe copy path and preserve its required assets.

Keep acknowledgments, progress and final text in the current request's language. Assess this with real-model runs as well as deterministic prompt/event tests; another instruction alone is not proof of compliance.

## 5. Implementation order and validation

1. Reproduce the reviewed event sequence with deterministic replay and identify the actual invalidation paths. Keep the model fixed for comparison.
2. Repair artifact/check evidence eligibility and export receipts together, including failure and replay cases.
3. Implement safe new-file copying through existing Sandbox boundaries and add approval/race/containment regressions.
4. Add structured limitations and investigate the table fidelity issue with saved-stage comparisons.
5. Align skill/tool guidance and evaluate the complete model-driven task on the matching deployment.

Implementation changes require relevant unit/integration tests, `pnpm test`, `pnpm lint` and `pnpm typecheck` under repository guidance. Contract changes require matching readers before writers and historical-event compatibility. Update the governing design/approval/browser documents and delivery status when implementation lands; this proposal does not mark any gate complete.

Use fixtures covering an embedded article, inline SVG-only graphics, local raster media, supported/unsupported tables, inaccessible frames, truncation, changed sources, partial writes and cancellation. Exercise stale receipts, changed check revisions, concurrent destination creation, existing files and symlink containment through the configured Sandbox routes.

Real-model acceptance must retain all requested deliverables and honest limitations. Measure redundant captures/exports, repeated verification calls, approval prompts, time to delivery, model requests/context growth, readable content and language compliance separately. A normal fixture should complete with one capture/export and no approval for a new contained copy; additional calls are acceptable when an observed issue justifies them. Lower call counts alone do not demonstrate task success. Deterministic fixtures do not establish public-page readiness or production isolation.

## 6. Boundaries

- Do not weaken privacy, sensitive-file, source-suppression, ownership, current authorization, explicit denial or approval persistence rules.
- Do not bypass the browser driver, guest routing, Sandbox or configured egress policy.
- Do not replace internal integrity checks with model assertions or certify semantic completeness from tool success.
- Do not repeat uncertain effects, rewrite historical events or mutate projections to repair task state.
- Do not introduce a new workflow engine or extra LLM validation pass for this request.
- Implementation was subsequently authorized by the user. Deployment, commits and other Git mutations remain outside this task.

## 7. Implementation follow-up

Delivered in the current checkout:

- Export publication receipts include output hash/size, saved media count, capture limitations and structured representation warnings.
- Exact-operation checks exclude screenshots from capture verification. Immutable captures and unchanged checks retain valid evidence across unrelated file effects and descriptive interpretation changes.
- Resource-specific checks bind to delivered file paths. Known new-copy destinations invalidate overlapping checks; export receipts bind their generated bundle and survive copies outside it. Unknown effects remain conservative.
- Status and rejected verification expose bounded reason/repair codes, check revision sequence, selected result sequence and the actual invalidating event sequence. Failed/missing results and torn effects remain distinct; diagnostic payloads omit source content and raw arguments.
- Bounded Linux new-file copying runs through existing Sandbox argv, with exclusive creation, descriptor-pinned parents, no symlink traversal and no local fallback. Existing destinations require a separate authorized replacement operation. Failures can leave partial newly created output; no automatic retry or unsafe cleanup is added.
- The reported table loss was traced to CSS grid cells represented as block spans. Capture and saved HTML retained their separation; tag-only conversion concatenated them. The converter now retains these layouts as inert HTML with `layout-html`, preserving source input hashes and reporting viewer compatibility.
- Skills/tool/context guidance explain receipts, warnings and targeted repairs. The existing guest acceptance script now runs the shared copy checks. An additional configured-route check never wakes or suspends a VM.

Validation and limits are recorded in [the acceptance report](export-verification-acceptance-2026-11-14.md). The original saved conversion input was reproduced exactly; its concatenated cell output is corrected offline. The configured running guest passed new-file copy acceptance. Two repeated fixed-model synthetic export trials completed with one capture, one export and zero approvals each, while still showing unnecessary inspection calls. These do not establish universal public-page coverage, viewer compatibility or production isolation. No application container was rebuilt/restarted, no guest image was rebuilt, and no deployment was performed.

Remaining release acceptance: matching reader/writer deployment and a full live-browser/model/guest export trial against representative public and embedded-document pages. New adapters without resource metadata retain conservative workspace invalidation; this is an explicit fallback, not an incomplete relaxation of unknown effects.
