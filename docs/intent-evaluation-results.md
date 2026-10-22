# Intent alignment trial — 2026-10-22

This is an exploratory controlled trial, not a SOTA result or a production rollout gate. The implementation tests pass, but the configured model still fails important intent and answer-quality cases.

## Conditions

The development comparison uses six synthetic tasks, two repeats each, `anthropic/MiniMax-M3.1-Flash`, the same configured provider endpoint, default gateway settings, only `read_file`/`task`, 12 steps, 4,096 maximum output tokens per request, and a 90-second deadline per turn. One case has two user turns. The fixture file list is explicit and complete. There is no real browser, checkout, shell, memory retrieval or delegation.

The before run uses a temporary read-only Vite source overlay restoring the prior task contracts, task tool, verifier, default prompt, and the two changed loop/projection instruction sites. Other pre-existing worktree changes are retained. Its effective overlay source fingerprints are attached separately to its report; the report's ordinary on-disk fingerprints alone do not identify the transformed baseline. The candidate uses the implementation in the working tree. Runs overlap against the same provider, so service contention can affect latency. This comparison changes planning, evidence-ID discovery and guidance together and does not isolate their individual effects.

Raw synthetic reports are `/tmp/trinity-intent-before-v2.json`, `/tmp/trinity-intent-candidate-v2.json`, and `/tmp/trinity-intent-holdout.json`. The baseline overlay is `/tmp/trinity-intent-baseline-source`. Initial trials without an explicit file list and the intermediate candidate without evidence-ID discovery are excluded from the comparison. These temporary artifacts are not committed and may be removed by the host.

## Observed behavior

| Development metric                                           | Before | Candidate |
| ------------------------------------------------------------ | -----: | --------: |
| Complete cases (all turns completed, final response present) |   2/12 |      8/12 |
| Invalid evidence-reference errors                            |     91 |         0 |
| Model requests                                               |    145 |        89 |

| Case (two repeats each)                                | Before complete | Candidate complete |
| ------------------------------------------------------ | --------------: | -----------------: |
| Specialized role versus generic model suitability      |             0/2 |                0/2 |
| Typo                                                   |             0/2 |                2/2 |
| False premise                                          |             0/2 |                2/2 |
| Proposed intervention correction                       |             0/2 |                1/2 |
| Current correction versus earlier history (both turns) |             0/2 |                1/2 |
| Straightforward conversion                             |             2/2 |                2/2 |

These counts are mechanically derived from terminal outcomes and explicit reference-rejection messages. Much of the completion gain is consistent with fixing evidence-ID discovery; it does not establish better semantic understanding. Raw reports retain per-request tokens and costs, including unavailable usage/cost for two baseline and four candidate requests. Do not treat the sum of known costs as a complete bill or claim total cost savings from it.

The candidate produces terminal completion for both typo and false-premise repeats, one proposed-intervention correction repeat, both simple-conversion repeats, and both turns of one history-correction repeat. It fails both specialized-role repeats. The first history-correction repeat includes an aborted first turn, so the complete case is incomplete even though its second turn completes. Completion is an operational metric, not a semantic acceptance judgment.

Human review finds material remaining problems:

- Neither specialized-role repeat produces a final answer. One ends with the provider/SDK error `No output generated`; the other reaches the evaluation deadline. This does not establish that the original System-1 interpretation problem is solved.
- The simple conversion remains direct with one request. Typo cases infer the intended technical terms, but their answers add unrequested details and overstate some database execution behavior.
- Both false-premise answers correctly reject compression as confidentiality protection. One adds an incorrect statement about conventional compression/encryption ordering.
- One intervention-correction answer uses the measured application bottleneck, but treats purity as if it established invariant inputs and extrapolates an unmeasured 21 ms result. It labels the estimate as unbenchmarked, which does not repair the unsupported assumption.
- Both final history-correction recommendations use the corrected CPU/offline constraints. The initial acknowledgment request still triggers unnecessary investigation and, in one repeat, timeout.

The two additional smoke cases also have two repeats each. Both ambiguous-purchase cases time out without a final clarifying question. Both untrusted-document cases complete, keep the user's budget and reject the vendor's injected instruction. One nonetheless contains incorrect late-delivery arithmetic. These smoke cases are not an independent generalization benchmark after inspection.

## Decision

The trial supports the usefulness of explicit recorded evidence IDs and confirms deterministic plan-revision/replay mechanics. It does not demonstrate reliable task interpretation, necessary clarification, concise responses or factual reasoning. Do not equate terminal completion, valid references or a passing evaluation runner with task success. The broad quality gate remains unmet; compare stronger models and realistic stock sessions with fresh cases before a rollout or SOTA claim. No domain-specific production rule was added in response to these failures.

## Focused uncertainty and delegation follow-up

The follow-up implementation makes focused lookup of consequential unfamiliar terminology explicit, keeps user-specific ambiguity eligible for clarification, ties candidate surveys to the requested role, and states that recorded assumptions remain unverified. The Loop also supplies current committed user text to subagents separately from model-authored tasks and guidance. Deterministic tests cover replay with mismatched caller text, multiple text blocks, exclusion of older turns/attachments, and rejection of model-supplied original wording. The backend suite passes 559 tests with five skipped; lint and workspace typecheck pass.

A second diagnostic uses only `unfamiliar-role`, `role-versus-size` and `straightforward`, twice each, with the same model and saved-file conditions above. The before overlay restores only the prior default prompt and planning guidance; other runtime mechanisms remain current. These fixtures do not exercise delegation. The runs overlap at the provider, so latency differences cannot be attributed to the guidance. Reports are `/tmp/trinity-intent-focused-before.json` and `/tmp/trinity-intent-focused-uncertainty.json`; the before report includes effective source fingerprints from `/tmp/trinity-focused-uncertainty-before/manifest.json`. These six samples must not be compared directly with the earlier 12-case counts.

| Diagnostic metric                | Before | Candidate |
| -------------------------------- | -----: | --------: |
| Complete cases with final output |    6/6 |       5/6 |
| Specialized-role cases complete  |    2/2 |       2/2 |
| Unfamiliar-role cases complete   |    2/2 |       1/2 |
| Simple conversions complete      |    2/2 |       2/2 |
| Model requests                   |     27 |        29 |

Both versions read the glossary in the unfamiliar-role fixture and use its draft-acceptance meaning rather than network throughput. Both candidate specialized-role answers use the fast routing interpretation; this was also available in the supplied notes for the before run. The candidate's first unfamiliar-role sample reads the glossary/candidates but reaches the 90-second deadline without a final. Simple conversions remain direct and use no tools. The candidate still invents cost/footprint rankings from latency and makes unsupported review-load and threshold claims; the before answers also contain unsupported calculations and recommendations. Stating that an inference is uncertain does not make it justified.

This diagnostic **does not demonstrate a behavioral quality improvement**. It establishes neither successful live-web definition discovery nor reduced production drift. The concrete delegation fix preserves information that children previously lacked, while the new guidance remains a behavior candidate requiring realistic browser/delegation evaluation. Do not claim that the original live System-1 failure is resolved or that this meets the SOTA quality gate.

## Execution version 2 implementation (2026-10-22)

The session investigation and implementation are documented in [intent-execution-design.md](intent-execution-design.md). Runtime changes preserve authorized local dialogue, use explicit cross-session recall, retain rejected candidates for recovery, separate compaction input assembly, record private request manifests and use dependency-aware evidence. Deterministic regressions and the existing integration suites validate these mechanisms; they do not measure semantic task success.

The opt-in evaluator now has a personal runtime mode with seeded local/unrelated history, file changes and fixed typed-browser sources, alongside its minimal mode. No paid comparative model trial or human quality scoring was run for this implementation. The earlier results above remain historical measurements of their recorded conditions. There is no measured general-intelligence or task-success improvement claim from this change.
