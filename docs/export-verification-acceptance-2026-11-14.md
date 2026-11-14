# Export verification acceptance — 2026-11-14

## Scope

Implements the remaining scoped repairs in [the improvement plan](improvement-plan-2026-11-14.md). Local code, offline historical-artifact reproduction, configured guest-copy acceptance and real-model synthetic task behavior are separate evidence. No deployment or production-isolation claim follows from these results.

## Table fidelity diagnosis

The reviewed session's immutable capture `3a7390e9-104f-49f8-b810-88b45081a7d1` retains the article's table-like content as a CSS grid with block-displayed span cells. Its child document has no native `table`, `tr`, `th` or `td` elements. The saved graph and inert per-frame HTML retain the cells and computed grid styles. Turndown's ordinary inline-tag handling concatenated adjacent cells.

Regenerating composed HTML from that saved manifest produced the original conversion input SHA-256 exactly:

`d37961fe860f64895b36894cb70cc4c50a0faa61004c2840ec24de5adc8332e1`

Offline conversion with the new layout rule produced SHA-256:

`c2c2fe28eb1008d758cde5d399bcf8870514563896ff070aac3a3e4fce1c4043`

The output retains separated span cells rather than the previously observed concatenated text. It is 475,477 bytes, versus the historical 221,644 bytes, because the captured grid HTML/styles are retained. Warnings are `inline-svg` and `layout-html`. This fixes the demonstrated concatenation without inferring headers/rows from geometry or modifying immutable capture artifacts. Rendering still requires a viewer that supports the retained HTML/CSS; the HTML bundle remains the fidelity fallback.

Deterministic tests cover both pure conversion and the capture → saved HTML → Markdown path with synthetic grid cells. Ordinary inline spans remain joined correctly; native GFM and unsupported-table behavior remain covered separately.

## Verification diagnostics

The evidence projection now supplies eligibility and structured rejection reasons together. Status returns at most one recent rejection per check, bounded by 32 checks. Explicit verification reports the selected receipt's rejection. Fields identify the check revision, receipt result and actual invalidating event sequence. Repairs distinguish selecting a matching receipt, reviewing a changed check, observing affected state and inspecting an uncertain effect before retry.

Tests cover known/unknown effects, overlapping and unrelated resource paths, failed results, missing/torn result pairs, check revisions, cross-turn selection, replay, bounded display and exclusion of private values/commands from diagnostic payloads. A torn effect names its actual call event, not a fabricated future result. Older plans keep legacy eligibility semantics.

Successful Markdown receipts derive their generated bundle scope from validated adapter output bound to the exact requested capture. A new copy outside that bundle preserves publication evidence; a change inside it invalidates current-output verification. Unknown or unclassified effects continue to invalidate conservatively.

## Configured guest-copy acceptance

The new source was exercised through `RemoteSandbox` and the authenticated `FirecrackerGuestRouter`/Node Agent route against the reviewed session's already running owned environment. Routing configuration came from the deployed worker; the development `.env` did not independently select Firecracker. Credentials were passed through the process environment without printing or writing them into reports.

Passed: Unicode bytes, new destination creation, repeated destination rejection, destination appearing after preflight, symlink rejection and pre-aborted cancellation. The script prohibits wake/suspend and has no local fallback. Uniquely named fixture artifacts remain in the session workspace for inspection; uncertain targets are not deleted for cleanup. No image rebuild or service restart was performed.

Reproduce using matching deployment configuration:

```sh
pnpm exec tsx --env-file=.env scripts/workspace-copy-acceptance.ts <owned-personal-session-id>
```

The shared checks also run from `scripts/firecracker-guest-check.ts`. A deterministic transport test routes the same checks through `RemoteSandbox` argv and rejects shell fallback.

## Real-model synthetic export trials

The opt-in test uses the existing AI SDK gateway, current task verification, real LocalSandbox/export/Turndown, and a synthetic fixed browser driver. Its page contains Chinese text, block-span grid cells, inline SVG and a captured local PNG. The browser skill is preloaded explicitly; this evaluates task execution after skill delivery, not runtime skill discovery. It does not exercise a live website or VM/browser capture.

Model: `anthropic/MiniMax-M3.1-Flash`, unchanged across trials. Each report records source hashes, conditions, calls/results, text responses, output bytes/manifests, usage and terminal outcomes; provider reasoning is excluded. Raw synthetic reports remain outside the repository.

| Run                | Repeat | Model requests |   Time | Captures | Exports | Approval prompts | Outcome   |
| ------------------ | ------ | -------------: | -----: | -------: | ------: | ---------------: | --------- |
| Initial diagnostic | 1      |             15 | 34.5 s |        1 |       1 |                0 | Completed |
| Initial diagnostic | 2      |              6 | 22.8 s |        1 |       1 |                0 | Completed |
| Follow-up          | 1      |             10 | 28.8 s |        1 |       1 |                0 | Completed |
| Follow-up          | 2      |              9 | 31.5 s |        1 |       1 |                0 | Completed |

Manual review: all four outputs retain text, separated grid HTML, inline SVG and a local relative PNG reference. Visible acknowledgments and final answers use Chinese. Capture/export checks verified without recapture or a second export. No task was completed merely by dropping checks.

Action economy is still imperfect. The initial first trial attempted an unsupported screenshot and redundant shell checks; the follow-up trials still inspected manifests/listings and one attempted unsupported compound shell syntax. Neither the small sample nor these differing source versions establish a causal improvement or an optimal call count. Qualified coverage reporting remains verbose. These are model-behavior observations, not grounds for adding another serialized LLM gate or weakening command policy.

Reports: `/tmp/trinity-export-eval-2026-11-14.json` and `/tmp/trinity-export-eval-final-2026-11-14.json`. The latter records the source state when those trials started; later diagnostic edge-case refinements are covered deterministically rather than claimed as additional model trials.

Reproduce the two-repeat evaluation:

```sh
TRINITY_RUN_EXPORT_EVAL=1 \
TRINITY_EXPORT_EVAL_REPORT=/tmp/trinity-export-eval.json \
node --env-file=.env node_modules/vitest/vitest.mjs run packages/core/test/export-model-acceptance.test.ts
```

## Release limits

Deploy matching contracts/core readers before writers. The local checkout does not update running application containers. Full deployed live-browser/model/guest export acceptance, representative embedded/public pages and broader viewer compatibility remain release checks. Existing deterministic native-table, embedded-document, cancellation and limit tests provide mechanism coverage, not universal content completeness.

## Local checks

`pnpm test`: 1,713 passed, 32 skipped (including opt-in acceptance tests). After a final diagnostic revision-sequence refinement, its six focused regressions also passed. `pnpm lint` and workspace `pnpm typecheck` passed. Paid model trials and the configured guest-copy run were invoked separately as recorded above.
