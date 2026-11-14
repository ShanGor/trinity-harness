# Agent behavior improvement plan — 2026-11-10

## 1. Purpose

Improve research quality, instruction compliance, and response time.
Give a supported answer to each part of the user request.
State important evidence gaps.
Use the requested language and delivery format.

Repair harness defects first. Keep the current model fixed during this work.
Collect comparison results alongside the repairs.
Do not make a model comparison a condition for fixing a known defect.
Consider a model change only after harness repairs and evaluation.

This document combines the first plan, the latest review, and the industry comparison.
Use this document for future work.
Keep the [session review](agent-behavior-review-2026-11-10-latest.md) as the detailed evidence record.

The writing follows ASD-STE100 principles.
Technical names are retained where necessary.
Formal ASD-STE100 compliance has not been assessed.

## 2. Terms

| Term               | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Claim              | A factual statement in an answer.                                                         |
| Delivered evidence | Source content that a tool returned to the model.                                         |
| Discovery          | A search that finds a new external destination.                                           |
| Decision brief     | A short record of the request, delivery requirements, findings, and unresolved questions. |
| Baseline           | The unchanged system used for comparison.                                                 |
| Candidate          | One proposed harness change. Model changes are a separate, final investigation.           |
| Holdout case       | A test case that was not used to develop the change.                                      |
| Release gate       | A condition that must pass before release.                                                |

## 3. Evidence

The first two reviewed sessions showed related failures.
Their prompts and web pages differed.
Do not treat them as a controlled comparison.

| Measure                    | First session                          | Second session                         |
| -------------------------- | -------------------------------------- | -------------------------------------- |
| Session ID                 | `01a1c590-0d92-7000-b317-b50e19434d34` | `01a1c5b2-daaf-7000-a0ad-58c602b57b0e` |
| Request                    | Background and nationality             | Background and country of birth        |
| Elapsed time               | About 9 minutes 48 seconds             | About 5 minutes 41 seconds             |
| Model requests             | 57                                     | 66                                     |
| Browser calls              | 55                                     | 66                                     |
| Tool errors                | 12                                     | 7                                      |
| Recorded model cost        | About USD 0.228                        | About USD 0.307                        |
| Final request input tokens | 99,230                                 | 122,907                                |

The second session found useful background information.
It correctly left the country of birth unconfirmed.
However, it had these failures:

- It changed from Chinese to English.
- It gave a long answer for a brief phone request.
- It made 42 more browser calls after it identified the remaining evidence gap.
- It added unsupported family-origin speculation.
- It assigned a departure year that the delivered passage did not establish.
- It combined conflicting appointment dates without an explanation.

The running worker contained the new guidance.
The final model input retained that guidance and the original request.
Missing deployment or lost instructions do not explain these failures.
The trace does not establish the model's internal cause.

A third session used `MiniMax-M3.1-Flash` instead of `MiniMax-M3`.
Its ID was `01a1c5ca-9526-7000-bcba-21baa6f20084`.
It took about 8 minutes 35 seconds and made 49 browser calls.
It kept the answer in Chinese and corrected a rejected citation range.
However, repeated searches and unsupported claims remained.
It made 21 searches through direct navigation and three through `web_search`.
The search detector did not track the direct searches.
The request had no phone-delivery metadata.
Do not score its length as a brief-phone violation.
These runs do not establish a primary model limitation.

## 4. Existing changes and remaining gaps

Implementation details and test results belong in [project-progress.md](project-progress.md).
Release conditions belong in [production-checklist.md](production-checklist.md).

The follow-up implements common discovery metadata, bounded stale-target reasons, and explicit reference-validation scope.
It also moves current recovery guidance next to the next decision.
The model remains fixed. No additional model calls are required.
This is a placement repair, not a new summary or an automatic answer reviewer.
The full decision-brief experiment, optional review, and Sources interface change still require separate evaluation.

| Existing change                        | Evidence and remaining gap                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Citation recovery suggestions          | Suggestions use bounded, validated, previously delivered passages. The latest session did not test this path.                                                                                |
| Navigation and load deadlines          | Two failures returned the 30-second deadline. This limits one command, not the complete task.                                                                                                |
| Search discovery warning               | The first version missed direct search navigation. The follow-up supplies common metadata for supported search formats across live operations. Real task-quality acceptance remains pending. |
| Unavailable-target warning             | The warning distinguishes repeated unavailable targets from channel failures. Recovery quality still needs evaluation.                                                                       |
| Multilingual search controls           | Deterministic tests cover native search controls. Live site acceptance remains necessary.                                                                                                    |
| Language, evidence, and phone guidance | The latest model input contained these instructions. The model still violated them. More instructions alone are insufficient.                                                                |
| Synthetic evaluation cases             | Cases cover uncertainty and phone delivery. Fixed pages do not test public search, blocked pages, or guest delays.                                                                           |

## 5. Required behavior

1. Preserve the exact requested fact. Keep birthplace, citizenship, residence, and ancestry separate.
2. Use delivered evidence to support claims. Identify search snippets as snippets.
3. Keep unexplained source conflicts unresolved. Do not invent dates to combine accounts.
4. Before further research, identify the unresolved question and a plausible source.
5. Change the method when repeated searches add no useful evidence.
6. Give supported findings when further research is unlikely to resolve the gap.
7. Use the requested language for acknowledgment, progress, and final output.
8. Keep phone output brief. Include each requested component and important limitation.
9. Match research effort to the task. Unused budget is not a reason for more work.

A warning, passed checklist, or low call count does not prove compliance.

## 6. Work plan

### Design rules for all phases

Use general contracts and recorded state to describe operations, evidence, and failures.
Do not add rules for a person, company, nationality, language, or sample answer.
Do not infer task type from isolated keywords.
Keep provider-specific format parsing inside the relevant adapter.
The core loop must consume a common validated result.
Do not add search-domain lists or URL patterns to the core decision logic.
Never decode an arbitrary redirect and treat it as a trusted source.

Use the user request to define the objective.
Keep model findings and interpretations separate from that request.
Measure progress from new relevant evidence and resolved questions.
A new tool call, changed query, or successful capture alone does not establish progress.
Mechanical checks cannot establish relevance or factual support by themselves.

Test the same mechanisms across several task types and tool paths.
Include useful continued research as well as repeated unsuccessful research.
Do not improve speed by dropping requested work.

### Measurement — Run alongside the repairs

Preserve existing traces as diagnostic evidence.
Prepare representative tasks alongside the repairs.
Include simple facts, complex research, Chinese phone delivery, missing facts, and conflicting dates.
Also include blocked pages, empty captures, partial passages, and direct search navigation.
Use synthetic data or approved evaluation data.
Do not copy private session text into public fixtures.

Compare the unchanged harness with each repaired candidate using the same model.
Keep tools, permissions, settings, initial state, and limits equal where possible.
Record differences that cannot be removed.
Retain all failed runs.
Use at least three runs per case for the first diagnostic comparison.
These runs identify variation. They do not establish statistical significance.

**Required record:** A reviewed report identifies changes in outcomes, tool behavior, time, and cost.
This work does not block a repair with sufficient evidence and deterministic tests.

### Phase A — Repair search measurement

Use common discovery information for equivalent operations.
Cover `web_search`, direct search navigation, and other supported discovery paths.
Create that information at the tool or adapter boundary from validated operation and page data.
A query parameter alone does not identify a search page.

Extract destinations from known search redirect formats for comparison.
Keep this parsing inside the provider adapter.
Apply existing URL validation to extracted destinations.
Exclude search controls and feedback links.
Ignore fragments when comparing destinations.
Keep original URLs and evidence references unchanged.

Do not count saved reads as discovery.
Do not count changed query text or snippets as new destinations.
Keep warnings advisory.
Do not add a forced-success rule or an arbitrary browser-call limit.

Test equivalent operations, direct and redirect links, empty pages, and no-result pages.
Also test changed snippets, fragments, provider changes, malformed redirects, and new destinations.
Test replay and reset for a new request.

**Exit condition:** Deterministic tests pass. Existing evidence protections remain effective.

### Phase B — Improve browser failure information

Add bounded reason codes for `STALE_TARGET` failures.
Distinguish missing snapshots, intervening operations, changed bindings, changed documents, and changed page structure.
Do not include page values, raw arguments, or secrets.

Distinguish a completed capture from readable source evidence.
Identify empty, blocked, login, missing-page, and transport results at the correct scope.
An empty capture does not prove that the page has no information.
One blocked page does not establish a complete browser failure.

Test immediate screenshots, dynamic pages, and shared Main/side browser activity.
Preserve freshness, ownership, privacy, and generation checks.
Establish the failure cause before changing recovery behavior.

**Exit condition:** Tests identify supported failure conditions without disclosure of protected content.

### Phase C — Test a concise decision brief

Keep the model fixed. Test this change separately from tool repairs.
Replace redundant guidance with a concise brief near the next model decision.
Include the committed request, corrections, language, and delivery format.
Preserve authenticated delivery metadata from submission through replay and dispatch.
Do not infer phone mode from the wording of the request.
Include supported findings, exact evidence references, unresolved questions, and source conflicts.
Include the observed failure and justified recovery when applicable.

Keep model interpretations separate from user requirements.
Make the brief reproducible from recorded events.
Preserve complete tool pairs and required instructions.
Do not let a summary grant permission or replace exact evidence.

Compare instruction compliance, factual support, input size, time, and cost.
Reject shorter context that removes important evidence or requirements.

**Exit condition:** Repeated evaluations show a useful improvement without a material regression.

### Phase D — Clarify evidence validation and test optional review

Distinguish valid evidence references from supported claims in tool results and guidance.
A successful citation check confirms access and delivered ranges.
It does not confirm every statement in the associated claim.
Do not promote model-authored findings into verified facts after a successful tool call.
Apply this distinction to all research domains.

Test optional review only if earlier changes leave important answer failures.
Compare the benefit with the added time and cost.
A second model cannot certify truth.

Give the reviewer only the request, answer, and relevant delivered passages.
Check support, coverage, uncertainty, language, and phone format.
Permit at most one review and one answer revision per trial.
Do not let the reviewer execute tools, repeat effects, or expand the task.
Retain the original answer and review result.

**Exit condition:** Human review confirms a useful net benefit on new cases.

### Phase E — Improve Sources presentation

Treat this as a separate product change.
Keep the full observation history available for inspection.
Define a distinct selection of passages used to support the answer.
Do not present blocked pages or search pages as proof of a claim.
Validate access and delivered ranges mechanically.
Evaluate whether each passage supports its claim.

**Exit condition:** The interface distinguishes observed sources from answer support.

### Final investigation — Consider model changes only if needed

First complete and evaluate the applicable harness repairs.
Identify any remaining failure from delivered inputs, tool results, and final answers.
Do not attribute a shared failure to the model while a known harness defect explains it.
If important failures remain, compare models separately on the repaired harness.
Keep tasks, delivery metadata, tools, permissions, and limits equal.
Report remaining uncertainty. Do not change the default model from a single trial.

## 7. Evaluation and release

Follow [intent-evaluation.md](intent-evaluation.md).
Compare one change at a time.
Use the same model for harness comparisons.
Reserve model comparisons for the final investigation.
Declare performance and cost thresholds before candidate runs.
Do not select thresholds after inspecting results.

Score these properties:

- Coverage of requested components.
- Factual support and citation accuracy.
- Correct treatment of missing or conflicting evidence.
- Language compliance from the first acknowledgment.
- Phone usability where applicable.
- Useful tool selection and recovery.

Record time, model requests, tool calls, errors, repeated destinations, input tokens, and cost.
Review all failures.
Use human assessment to check automated grades.
A passing test or grader does not prove answer quality.

Add new holdout cases before a release decision.
Keep individual results and aggregate results.
Report uncertainty and evaluation limits.
Do not claim SOTA performance without suitable independent comparisons.

For code changes, run relevant tests, lint, and typecheck.
Test replay when recorded state or context changes.
Test browser changes in a real guest before release.
Include a complete Chinese phone research turn.
Measure the shorter deadline's effect on slow pages.

Deploy matching components through the normal release process.
Confirm the running versions.
The existing increment needs no migration or guest image rebuild.
Assess new runtime changes separately.
Changing the checkout does not update running services.

## 8. Safety and scope

Preserve append-only events, exact evidence ranges, owner checks, and approvals.
Keep private request artifacts private.
Do not retry unknown effects automatically.
Do not change browser drivers after failure.
Do not weaken sensitive-page or stale-target checks.
Do not add automatic model calls for every request without evaluation.
Use configured budgets to bound cost and reserve a truthful final response.
A budget limit does not prove completion.

Paid model trials remain opt-in.
This document does not start trials, deploy changes, or change the default model.

## 9. Industry basis

The plan uses published engineering methods.
It is not a demonstrated SOTA design.
Public descriptions do not establish private product behavior for this exact task.

| Published source                                                                                                | Relevant method                                                                   | Application here                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Anthropic Research system](https://www.anthropic.com/research/multi-agent-research-system)                     | Match effort to complexity. Inspect traces. Evaluate support and tool efficiency. | Establish proportional research and outcome tests. Do not add multiple agents to simple requests by default. |
| [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | Focus useful context. Retrieve information when needed. Reduce redundancy.        | Test the decision brief. Preserve exact evidence references.                                                 |
| [OpenAI agent evaluation](https://developers.openai.com/api/docs/guides/agent-evals)                            | Inspect traces. Compare changes with repeatable datasets.                         | Establish a baseline. Separate model and harness comparisons.                                                |
| [Gemini Deep Research](https://gemini.google/overview/deep-research/)                                           | Plan and revise complex research.                                                 | Match research depth to the request.                                                                         |

Public methods inform the experiments.
Trinity evaluation results must determine which changes to retain.

## 2026-11-13 follow-up: explain the current request

The latest reviewed Chat used MiniMax-M3.1-Flash. The market-analysis turn made
100 tool calls in 19 minutes 6 seconds. Its next request asked what one attribution
meant. That turn made 22 calls in 3 minutes 27 seconds: 18 browser calls and four
failed research-note records. The first request required current research. The
second did not require a new report. The model had the prior answer and current
request. It added quotation checks, succession analysis and event-date checks.
These observations show scope expansion. They do not establish a model limit.

Implement these repairs before a model change:

1. Export tool schemas as input schemas. Keep server defaults optional.
2. Expose citation alternatives. Reject incomplete references. Keep evidence checks.
3. Resolve the requested outcome and conversation reference before choosing a tool.
   Identify only missing information that can change the requested answer.
4. Explain or transform available text directly when it is sufficient. Use a focused
   lookup for a needed uncertain fact. State a material correction briefly.
5. Keep research notes optional. A rejected note does not create a research task.
6. Compare explanation cases with explicit verification cases. Keep tools available
   in both. Keep the model fixed. Review scope, evidence, calls, latency and answers.

These repairs are implemented in the checkout. No keyword router, fixed tool cap,
additional model call or mandatory planning tool was added. Full semantic decision
briefs remain a separate experiment. The live worker inspected during review did
not contain the preceding browser/guidance repairs. Deploy matching services before
claiming that a later live turn evaluates this implementation. No rollout or
real-provider quality gain is claimed here.
