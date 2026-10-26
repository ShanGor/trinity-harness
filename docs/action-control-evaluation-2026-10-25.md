# General action controls and evaluation — 2026-10-25

The implementation improves action-control mechanisms and evidence selection. These development trials do **not** establish a general intelligence or efficiency gain. Execution completion is not a semantic quality score.

## Changes

- General runtime instructions tie actions to unresolved user requirements, preserve the user objective across short continuations, and distinguish previous assistant proposals from authorization. Current safe policy snapshots supersede historical assistant statements. Personal actions remain inside the assigned guest VM.
- Replay-derived guidance covers repeated failures and unchanged reads across tools, with scope-based invalidation. It advises strategy changes without declaring success or automatically terminating legitimate work.
- Optional `TASK_MAX_TOOL_CALLS` shares conservative durable wave reservations across parent/children/recovery. Complete waves that cannot fit are refused before approvals/execution; omission stays unlimited. Model budgets and final evidence checks remain independent.
- Stock v2 verification checks for a minimal committed plan before mutation/unknown-effect tools. This moves an existing final-verification prerequisite before execution, including small edits. Reads/direct answers remain plan-free; policy denial retains precedence.
- `task verify` accepts an exact eligible `resultSeq` or recorded `callId`. Both must agree when present. Active eligible non-browser tool results receive an adjacent runtime reference generated from the same eligibility projection as verification. Stored values, typed browser receipts and all evidence fences are retained.

## Conditions and scope

Both baseline and candidates used `anthropic/MiniMax-M3` through the same configured AI SDK endpoint, personal-context fixture runtime, two repeats per case, three development cases, the same tools/fixtures, verification enabled, 24-step/4,096-output-token/120-second-per-turn evaluation ceilings. Task tool-call limits were not enabled in these model trials; their enforcement is covered by deterministic tests. Runs were sequential rather than concurrent across variants, but provider latency remains uncontrolled.

The fixtures cover a short retry after an overbroad assistant offer, diagnosis from a sufficient supplied measurement, and an authorized configuration edit with read-back. They use in-memory ports and no real guest, public browser, shell or external effects. This does not reproduce the original large real-session tool surface or prove that the original 20-call behavior cannot recur. No production user transcript was exported.

## Development iterations

These are all iterations, including the failed intermediate sample; later candidates were revised after inspecting these same development cases. This is diagnostic tuning, not a blinded or independent benchmark. No holdout was used.

| Version                             | Execution-completed samples | Model requests | Proposed tool calls | Error tool results |
| ----------------------------------- | --------------------------- | -------------- | ------------------- | ------------------ |
| Original baseline                   | 6/6                         | 25             | 17                  | 0                  |
| First action instructions           | 6/6                         | 24             | 16                  | 0                  |
| Expanded answer guidance            | 6/6                         | 24             | 19                  | 0                  |
| Compact instructions                | 5/6                         | 23             | 14                  | 0                  |
| Pre-execution plan check            | 6/6                         | 27             | 21                  | 4                  |
| Sequence selector                   | 6/6                         | 25             | 19                  | 2                  |
| Adjacent evidence reference (final) | 6/6                         | 24             | 18                  | 2                  |

Final proposed call counts by case (two repeats):

| Case                          | Original baseline | Final candidate |
| ----------------------------- | ----------------- | --------------- |
| `retry-original-objective`    | 1, 1              | 1, 1            |
| `bounded-readonly-analysis`   | 1, 1              | 1, 1            |
| `scoped-configuration-change` | 6, 7              | 7, 7            |

## Review of outcomes and remaining weaknesses

- Both baseline and final candidate read each informational fixture exactly once and left its workspace unchanged. They identified the missing CSV header and the dominant measured queue stage. Some answers still added unsupported implementation/causal details or unnecessary follow-up suggestions. Those are model-quality weaknesses, even though execution completed.
- Both final edit samples produced the requested `retries=3`, preserved the endpoint and timeout, and read the file back. Each first proposed an edit before a plan: the new check refused it without changing the file, after which the model planned and proceeded. This demonstrates enforcement, not complete instruction following.
- Intermediate trials guessed opaque provider-style call IDs. Sequence selection alone also produced wrong references. In the final two edit samples the model used the adjacent exact `resultSeq` correctly, without evidence-selection repair calls. That small observation does not establish a reliable error-rate reduction.
- The final version proposed 18 tool calls versus the original 17. Two final calls were refused before execution, so counts must distinguish proposals from effects. Model requests were 24 versus 25. These small differences do not support a general efficiency claim. The intermediate compact-prompt variant completed only 5/6 samples; that failure exposed the plan/precondition mismatch rather than being omitted from the results.
- No production model/provider was changed. Broader representative tasks, stronger-model comparisons and blinded human scoring are still required to assess general judgment. A budget bounds activity and guidance informs strategy; neither certifies semantic success.

## Provenance and local artifacts

The baseline ran with a temporary Vite pre-transform restoring the three behavior sources captured before this task. Other pre-existing checkout changes were retained. The report's on-disk fingerprints alone do not identify those transformed modules; their effective SHA-256 values were:

- `packages/core/src/loop/agent-loop.ts`: `d4b66c3983a007422e4260b42bda6766aed0e3fd2259d15c388c9bd02572403b`
- `packages/core/src/loop/progress-guidance.ts`: `ea44ef81598e1d4ab67c3bf34111179b6b2376d18e3c6938c2031d49020150aa`
- `packages/shared/src/env.ts`: `2faebbfd295cbd15e8c3f2b5a5c051b0887bbf322443301de9959dfa5552513f`

The baseline was recorded before sequence-selection and adjacent-reference changes; the final report records the later checkout's source fingerprints. Reports retain synthetic traces, outcomes, workspace states, model usage and metrics under `/tmp/trinity-action-*-report.json`. The original override source map is `/tmp/trinity-action-baseline.json` and its config is `/tmp/trinity-action-baseline.config.mts`. These are local temporary artifacts, not committed archives.

## Verification and deployment

The full backend suite passed: **820 passed, 8 skipped**. Regression coverage includes concurrent reservations, parent/child sharing, crash/replay, prompt isolation, no hidden ceiling, deadline rejection, refusal of oversized waves before effects, pre-plan mutation refusal, current-prompt guidance persistence, exact sequence round-trip through personal context, failed/stale/previous-task/mismatched evidence rejection, and preservation of raw result values. Lint, workspace typecheck, formatting checks and the production web build passed. The Helm value/template follows the existing optional-ceiling pattern; Helm is not installed on this machine, so chart rendering was not verified.

These are control-plane changes. Existing development watch processes reload the sources; the local API health check passed. No guest image build, VM restart or physical-host agent capability is introduced. `TASK_MAX_TOOL_CALLS` remains opt-in and was not added to the user's `.env`; upgrade matching event readers before enabling its additive event writer. See [deployment controls](deployment-guide.md#general-action-controls).
