# Research execution evaluation

## Task

Original question: “is Microsoft Teams planning to support MCP apps?”

The useful answer must distinguish interactive MCP Apps UI hosting from MCP server/tool integration and Agent Store distribution. Missing roadmap evidence supports an uncertain conclusion, not proof that Microsoft has no plans.

## Observed runs

These are real Trinity sessions using the configured model, worker, sandbox and the user's Chrome CDP endpoint on port 9222. Evaluation sessions are separate from the original conversation. No pending approval was automatically accepted.

| Run                                               | Model steps | Approval requests | Outcome                                              |
| ------------------------------------------------- | ----------: | ----------------: | ---------------------------------------------------- |
| Original `01a11e95-42b1-7000-86a2-bb4d34f5d98b`   |          32 |                31 | Step budget exceeded; no final answer                |
| Evaluation `01a11fb7-81e0-7000-9c28-2c449f4a15ed` |          29 |                 0 | Completed in 263 seconds, with three primary sources |

The completed evaluation used 18 browser/shell calls, two skill loads and eight research calls. It used 839,083 input tokens and 11,710 output tokens summed across model requests; this is cumulative usage, not the size of a single context window. One run does not establish a general efficiency improvement.

Intermediate evaluations exposed several problems that informed the implementation:

- Article extraction selected recommendation cards instead of the main article on some Microsoft pages. The extractor now prioritizes explicit article bodies, primary articles and main content, with DOM regression fixtures.
- Harmless `head`/`tail` output filters and `2>&1` triggered approvals. Prefix matching now accepts these narrowly bounded forms while rejecting arbitrary shell composition and file redirects.
- Evidence collection continued without reconsidering the question. Persisted progress guidance now requests initial notes after multiple extracts and updated conclusions after two further sources.
- A four-minute evaluator timeout interrupted an earlier run after 26 steps. This was an evaluation timeout, not Trinity's step limit; the completed run used a longer evaluation deadline.

## Answer quality and subsequent correction

The completed run cited the Microsoft 365 Developer Blog and Microsoft Learn, distinguished Copilot's MCP Apps host from Teams MCP servers, and kept uncertainty about a Teams UI roadmap. However, its final answer also included an incorrect guess about the research validator's turn boundary and phrased the absence of an announcement too broadly before qualifying it later.

Six research-note updates were rejected because a citation's URL or exact passage did not match the extracted page. Successful earlier notes remained available. After this run, mismatch errors were expanded to identify the offending citation, distinguish URL/quote/unknown-call errors, and provide observed source identifiers and a bounded text excerpt. The skill now directs the model to correct or omit that citation and keep internal bookkeeping out of the final answer. These final refinements have deterministic test coverage; they have not been evaluated in another complete live run.

## Runtime behavior

- Main turns default to 64 model steps, configurable through `MAX_TURN_STEPS`; the final step has no tools and requests an answer with limitations.
- Evidence notes and progress guidance are replayable session events, with bounded spill recovery and no new database table.
- Quote matching establishes that text was observed; it does not validate a claim's interpretation or a website's truthfulness.
- Active work retains tool observations. Completed turns retain the user's input and final response in subsequent model context; internal notes and progress messages remain in the event log.

Regression coverage includes provenance rejection, restart replay, spill recovery, extractor DOM selection, repeated reads, note checkpoints, command prefix restrictions and the 64-step final-answer boundary. Run `pnpm test`, `pnpm lint` and `pnpm typecheck` to reproduce repository checks.
