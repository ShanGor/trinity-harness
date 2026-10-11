# Controlled browser research comparison

Date: 2026-10-09. Model: `anthropic/MiniMax-M3`, adaptive thinking, the same AI SDK gateway/configuration for all modes. Existing Chrome CDP 9222 and agent-browser 0.38.2; no managed Chrome or public website browsing.

The completed cohort comprises 24 runs: two repeats of four synthetic tasks (long article, documentation/code, Teams capability table, expandable caveat) in three stages. Each run has an independent pinned tab, a ten-step cap and a 180-second deadline. The article, table and interaction tasks allowed two concurrent runs; the corrected documentation runs were serial. A malformed documentation fixture was discovered and all six affected rows were excluded and replaced. All modes within a task share the same concurrency setting; shared Chrome input/render races occurred, so the checked-in runner now defaults to serial execution. The capture stage deliberately omits interaction operations, making the expandable task a capability check rather than a fair reading-efficiency comparison.

The legacy stage uses bounded literal commands and the bundled legacy extractor through Bash-shaped events, including the existing URL/quote validator. Its fixed extractor marker avoids model-authored JavaScript and excludes the old workflow's script-construction/skill-loading costs; it is a conservative fixture baseline, not a reproduction of the original public-web session. The typed stages use persisted observations/ranges and the same research tool. No pending user approval was accepted; only these controlled fixture operations used an explicit permissive test policy.

## Aggregate measurements

Input/output tokens are actual provider-reported cumulative usage over requests, not one context window. Bytes include complete serialized browser results; screenshots are charged separately.

| Mode        | Completed | Steps | Input tokens | Output tokens | Browser calls | Saved retrievals | Citation-note rejections | Delivered text bytes | Image bytes | Literal checks |
| ----------- | --------: | ----: | -----------: | ------------: | ------------: | ---------------: | -----------------------: | -------------------: | ----------: | -------------: |
| legacy      |         7 |    50 |      143,374 |        16,583 |            29 |                0 |                        8 |               33,304 |           0 |          22/30 |
| capture     |         8 |    42 |      224,194 |        17,435 |            24 |               10 |                        2 |               81,658 |           0 |          22/30 |
| interaction |         8 |    48 |      287,417 |        14,990 |            35 |               12 |                        1 |               86,011 |           0 |          25/30 |

For the six reading runs per mode (excluding the deliberately unavailable interaction task), legacy used 102,143 input tokens with 6 citation-note rejections; capture used 157,240 input tokens with 0 citation-note rejections; interaction used 201,413 input tokens with 0 citation-note rejections. Fewer citation failures did **not** imply lower provider usage. Catalog/receipt overhead, repeated observations and model strategy all differ; this experiment does not isolate their individual effects.

## Per-run outcomes

The checks are literal, deterministic coverage signals, not an independent semantic grader. Review the final answers and evidence as well.

| Repeat | Task          | Mode        | Outcome   | Steps | Input tokens | Citation rejections | Literal checks |
| ------ | ------------- | ----------- | --------- | ----: | -----------: | ------------------: | -------------: |
| 1      | article       | capture     | completed |     6 |       41,740 |                   0 |            2/3 |
| 1      | article       | interaction | completed |     8 |       70,943 |                   0 |            2/3 |
| 1      | article       | legacy      | completed |     8 |       35,211 |                   3 |            2/3 |
| 1      | documentation | capture     | completed |     3 |        8,730 |                   0 |            4/4 |
| 1      | documentation | interaction | completed |     3 |       11,035 |                   0 |            4/4 |
| 1      | documentation | legacy      | completed |     5 |       11,077 |                   0 |            3/4 |
| 1      | interaction   | capture     | completed |    10 |       48,147 |                   2 |            1/4 |
| 1      | interaction   | interaction | completed |    10 |       40,447 |                   0 |            1/4 |
| 1      | interaction   | legacy      | completed |     7 |       16,307 |                   0 |            4/4 |
| 1      | table         | capture     | completed |     3 |        9,574 |                   0 |            4/4 |
| 1      | table         | interaction | completed |     3 |       11,710 |                   0 |            4/4 |
| 1      | table         | legacy      | completed |     5 |       12,512 |                   0 |            4/4 |
| 2      | article       | capture     | completed |     9 |       78,141 |                   0 |            2/3 |
| 2      | article       | interaction | completed |     9 |       86,337 |                   0 |            2/3 |
| 2      | article       | legacy      | completed |     4 |       15,363 |                   1 |            2/3 |
| 2      | documentation | capture     | completed |     3 |        9,137 |                   0 |            4/4 |
| 2      | documentation | interaction | completed |     3 |       10,301 |                   0 |            4/4 |
| 2      | documentation | legacy      | completed |     6 |       14,391 |                   1 |            3/4 |
| 2      | interaction   | capture     | completed |     5 |       18,807 |                   0 |            1/4 |
| 2      | interaction   | interaction | completed |     9 |       45,557 |                   1 |            4/4 |
| 2      | interaction   | legacy      | error     |    10 |       24,924 |                   2 |            0/4 |
| 2      | table         | capture     | completed |     3 |        9,918 |                   0 |            4/4 |
| 2      | table         | interaction | completed |     3 |       11,087 |                   0 |            4/4 |
| 2      | table         | legacy      | completed |     5 |       13,589 |                   1 |            4/4 |

## Quality review and rollout decision

- Every article answer changed the requested curly quotation marks to ASCII quotes. Server-resolved citation metadata retained canonical source text, but direct final-answer quoting remains a quality failure. Block references solve note transcription; they do not force a model to reproduce quotes faithfully in prose.
- All modes found the long article's species limitation after continuation guidance was added. Repeated broad reads still increased cost on some runs. The final typed description and persisted guidance explicitly distinguish fresh capture from saved pagination/search.
- Teams/table answers distinguished UI hosting, server tools and distribution and preserved roadmap uncertainty. These are synthetic claims used to test reading, not evidence about Microsoft's current plans.
- Both corrected documentation runs in each typed stage preserved the requested code formatting and all policy caveats; both legacy runs flattened the code. Header/cell structure and code whitespace remain intact in the saved semantic artifact; model rendering can still change them. Readability fixture comparison retained the species caveat, while semantic blocks additionally preserve explicit table/code structure; Readability was therefore evaluated without replacing canonical extraction.
- Checked actions rejected malformed arguments and stale references rather than remapping them. One checked interaction run did not reveal the caveat; another succeeded after refreshing its target. A legacy interaction run exceeded its step budget. Native pointer activation also intermittently acknowledged an event without the expected visible effect. Keyboard activation also acknowledged without a reliable outcome in follow-up checks. Native button/link activation was subsequently changed to a fixed, checked DOM activation, with bounded readiness and post-action observations. Both serial repeats of this final activation follow-up revealed and preserved the excluded-population caveat (4/4 checks each); one still needed a refreshed snapshot and one retried malformed research arguments. This follow-up is separate from the 24-run comparison. No automatic repeat-after-unknown fallback was added. Synthetic DOM activation is not a trusted user gesture, so sites that require one may need an explicitly requested pointer/key operation and a fresh observation.
- Screenshots carry visual provenance and appear in the existing evidence drawer. Shared Chrome can delay compositor frames: a bounded paint wait records partial readiness on timeout, warns that pixels may lag the DOM, and disables coordinate actions from that image; they cannot authorize text quotes. The model can still omit caveats or make unsupported interpretations. Collected sources are not a claim-truth verdict.

The implementation is available in explicitly configured trusted-CDP mode. The experiment does **not** pass a general efficiency/answer-quality rollout gate. No savings percentage or production isolation guarantee is claimed. Before broad rollout, require complete caveat coverage, exact requested quotes/code, no unsafe accepted citations/actions, and a median cumulative input-token target of at most 80% of a comparable legacy baseline on the reading tasks, without sacrificing quality. These are next evaluation targets derived after measuring the baseline, not achieved results.

## Reproduction and artifacts

See [deployment-guide.md](./deployment-guide.md#model-comparison) for the opt-in command. The runner saves provider usage, browser/retrieval calls, repeated-exposure indicators, image bytes, latency, final answers, citations and bounded call/error traces. The validated cohort's raw local report is `/tmp/trinity-browser-evaluation-validated.json`, assembled from `/tmp/trinity-browser-evaluation-comparison.json` with its six documentation rows replaced by `/tmp/trinity-browser-documentation-corrected.json`. These contain only controlled fixtures. Earlier exploratory runs with an invalid legacy provenance adapter were excluded entirely. The final serial native-DOM interaction follow-up is `/tmp/trinity-browser-interaction-dom.json`, recorded separately so it is not mixed into the comparison. Intermediate keyboard activation follow-ups did not consistently reveal the caveat and are not counted as final-implementation results.

Deterministic tests cover DOM visibility/roles, scoped paths, stale/disabled/sensitive targets, authorization, Unicode ranges, budgets, image corruption/session boundaries, saved replay, API ownership and the React evidence drawer. Managed Chrome, enforced browser-side network containment, complete private-page redaction, global input coordination and automated orphan GC remain deployment TODOs, as requested for managed deployment.
