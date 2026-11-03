# Main chat: cache-aware context and date organization

Design decision: 2026-11-03. Initial implementation is available in source; stable
Main context segments are opt-in pending real-provider evaluation. Main date
separators are included in the Web build. This is not a deployed-runtime guarantee.
This extends [personal assistant §6](refactor-as-personal-assistant.md#6-main-chat-topic-history-and-memory)
and [intent execution §4](intent-execution-design.md#4-context-that-supports-interpretation).
Delivery tracking belongs in [project progress](project-progress.md) and release
acceptance in [production checklist](production-checklist.md).

## Product requirements

Main remains one continuous conversation. Its visible transcript, model working
context, durable memory and searchable source history have separate lifecycles.
Midnight adds a visual date boundary; it never closes the session, discards active
work, grants permission or forces a model-context reset. Yesterday's information
may remain in working context, but there is no guarantee that all of yesterday is
loaded and no mandatory daily summary injection.

Use bounded working context that stays stable across related turns. Preserve the
current request, corrections, loaded instructions, relevant recent dialogue and
active execution state. Keep older history searchable through the existing
`recall` tool with exact authorized source expansion. Explicit applicable saved
preferences remain available without requiring the model to rediscover them.
A daily digest, if added later, is a derived retrieval aid with source ranges and
an as-of watermark; it is not the authoritative task state or a required daily
prefix. Daily digest generation is outside this implementation plan.

## Cache-aware assembly

A bound is a model-input capacity limit, not a requirement to slide or regenerate
the dialogue window on every request. Reconstruct exact request inputs from
committed records while reusing unchanged rendered sections. Append eligible
new dialogue within a working-context segment, then compact/rebuild at deliberate
boundaries. A segment is versioned context metadata, not another session or an
authorization boundary. Do not retain completed reasoning, progress or raw tool
histories solely to improve cache hits; existing completed-turn projection rules
still apply. Such projection transitions can legitimately reduce prefix reuse.

Provider caching generally depends on an exact compatible prefix. Keep static
instructions and tool definitions deterministically ordered at the beginning;
place changing request metadata, current control guidance and optional retrieved
data after reusable sections where provider roles and correct chronology permit.
Do not move untrusted reference data into trusted instructions to improve caching.
Do not reorder or fabricate user/assistant/tool messages. Volatile timestamps,
request IDs and refreshed receipt text must not unnecessarily rewrite an otherwise
unchanged prefix. Retain exact audit metadata outside model text when it is not
needed by the model.

Within a segment, preserve the admitted dialogue membership and rendering rather
than reranking or dropping the oldest exchange after each request. Newly retrieved
sources enter through ordinary recorded tool results/selection receipts; reuse an
unchanged snapshot instead of regenerating a running summary. A genuinely new
request need not inherit unrelated history merely to preserve a cache hit. At a
rebuild, choose a bounded recent dialogue seed and applicable explicit references;
other history stays retrievable. No mandatory semantic classifier or keyword-based
topic-reset rule is introduced. Topic labels alone cannot trigger a destructive
reset or declare an unresolved objective complete.

Rebuild/compaction reasons must be explicit and replayable: context pressure,
explicit user request to start fresh, invalidated source or memory policy,
changed instructions/projector/provider configuration requiring new rendering,
or a recorded relevance decision. Do not rebuild solely because the date changed
or a cache expired. Inactivity can inform a future evaluated policy, but initially
has no fixed reset threshold. Before pressure reaches the dispatch limit, create
a checkpoint and establish a new reusable segment. A failed/empty/truncated
checkpoint preserves the previous valid state; if no valid request fits, fail
explicitly rather than silently removing required content.

Current correction, deletion, forgetting, source exclusion and authenticated
permission checks always take precedence over reuse. Validate before dispatch
and effects. Invalidate affected segments/checkpoints immediately under existing
fences; never delay suppression until a convenient compaction. Preserve the
original unresolved request, recent steering, complete active tool pairs, loaded
instruction snapshots, candidate recovery, budgets and unknown effects. New
context does not authorize replaying old effects or resuming unrelated old work.

Persist segment selection/version, source watermark/ranges, rendering version,
rebuild reason and immutable snapshots/references through contracts and existing
append-only session events/private request artifacts. Hashes alone are insufficient
for reconstruction. Use PG/session locking and expected revisions for concurrent
Main prompts; workers must not depend on process-local caches for correctness.
Exact snapshots remain private under `model-context/`. Reuse cannot cross owners,
tenants, sessions or authenticated memory scopes. Children receive only delegated
context through existing scope and policy fences, never the whole Main segment.

## Cost and latency criteria

Optimize total cost and successful user outcomes, rather than cache-hit percentage
alone. A smaller cold prompt can cost more than a larger cached prompt; repeatedly
sending cached irrelevant history also has a cost. A cache is an optimization,
not durable memory, and its expiry must not change correctness.

Use each request's recorded model/price snapshot and reported usage: uncached
input, cache read, cache write and output (reasoning remains within output).
Include compaction, retrieval/model calls and rebuild warm-up in comparisons.
Missing cache/pricing information remains unavailable, never zero or an assumed
hit. Do not hardcode a universal 0.1 cache multiplier, retention time or guaranteed
provider hit. Keep SDK/provider options behind existing LLM contracts and AI SDK
adapters, with deterministic fallback when caching is unsupported. No provider
HTTP bypass or new shared cache service is required.

Measure rendered common-prefix tokens as an estimate separately from provider
reported cached tokens. Use existing request artifacts for private diagnostics;
aggregate metrics must contain no prompts, identities, paths or source content.
Pricing and retention are model/provider specific: see official
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
and [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Date organization

Implement Main date separators independently of cache-aware assembly. Group whole
prompt/response exchanges by the committed prompt timestamp in the selected IANA
timezone; a response crossing midnight stays with its prompt. Use calendar dates,
not fixed 24-hour intervals. Pagination must avoid duplicate separators at page
joins and retain stable message references, scroll position, streaming and drafts.
The existing History date/timezone preference is browser-local; reuse it for the
first UI release, with the browser timezone as fallback. Account-persisted timezone
and prospective timezone-history policy remain follow-ups, not delivered claims.
Timezone changes regroup the UI only and never mutate timestamps or model context.

## Initial implementation and rollout

`CONTEXT_SEGMENTS_ENABLED=true` enables stable selection for personal Main in both
stock composition roots; its default is false. Helm exposes
`config.contextSegmentsEnabled`. With the flag off, legacy selection remains in
use. Side Chat and Work keep their existing selection behavior. Provider caching
is requested through the existing LLM port/AI SDK gateway: Anthropic's supported
automatic ephemeral cache option is enabled, while OpenAI uses its native automatic
prefix caching and unknown providers receive no Anthropic options.

Segments live in additive `memory/selection.receipt.segment` metadata; no new event
type, service or DB migration is required. Deploy readers with the expanded receipt
schema before enabling writers. Segments carry ID/revision, configuration digest,
capacity and a rebuild reason. Exact dialogue snapshots/source ranges stay in the
receipt and private model-input manifests. New admissions use an expected-sequence
append; ordinary Main execution still uses its existing cross-process lock.

The current conservative implementation bounds dialogue to the existing maximum
64,000 characters, further limited by model input/output room, with a 64-exchange
schema safety cap. A new seed targets half that capacity, keeping recent whole
exchanges and leaving append room. Only an oversized newest seed exchange is
excerpted, with exact expansion ranges. Stable admission retains the original
excerpts. Rebuild reasons currently implemented are initial admission, capacity,
policy, source invalidation, rendering/model/tool configuration and dispatch
pressure. Explicit freshness/relevance controls and semantic topic selection remain
follow-ups; there is no automatic topic or inactivity reset. Active execution
compaction and interrupted-objective preservation retain their existing paths.

A changing prompt reference is rendered after reusable dialogue instead of inside
the system prefix for segmented Main. Other changing system guidance, provider
configuration, tool-set changes and completed-turn filtering can still reduce
cache reuse. No guaranteed hit ratio or monetary saving is claimed. The deterministic
10-turn fixture retains 9,000 reusable source characters versus 3,000 for a six-turn
sliding baseline; these are source-character measurements, not provider token counts.
Existing reported usage and first-text latency remain the source for provider trials.

Main date separators and message timestamps share the valid browser-local History
timezone. Invalid saved zones fall back to the browser zone. A timestamp tooltip
includes the timezone. No account timezone persistence or daily digest was added.

## Implementation sequence

| Phase                          | Concrete work and boundaries                                                                                                                                                                                                                                                                  | Acceptance before advancing                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Baseline                    | Inspect actual rendered requests in Context Manager, PersonalContext, Loop assembly and AI SDK gateway. Quantify prefix churn from dialogue trimming, memory receipts, dynamic guidance, tool schemas and completed-turn projection. Reuse existing usage accounting.                         | Deterministic fixtures identify the first changed section; record baseline total input/read/write/output, cost availability and first-text latency. Do not claim prefix equality proves a provider hit.                                                                       |
| 2. Replayable context segments | Define additive Zod metadata/events in `packages/contracts`; implement segment projection and atomic admission/rebuild through existing Session Core/Context Manager ports. Select bounded whole dialogue exchanges and preserve unresolved input. Keep the current path as rollout fallback. | Tests cover stable membership across related turns, whole-exchange bounds, simultaneous queued prompts, restart/torn-tail replay and old-log compatibility. Deploy compatible readers before writers; generate migrations only if the reviewed persistence design needs them. |
| 3. Assembly and caching        | Integrate PersonalContext and purpose-specific Loop assembly. Stabilize eligible rendered prefixes, append new material, record pressure/invalidation/relevance rebuild reasons and use supported AI SDK cache options. Preserve assistant/compaction request separation.                     | Exact rendering tests cover append reuse, legitimate completed-tool removal, compaction warm-up/reuse, schema/model/instruction changes and unsupported providers. Validate final input plus output reserve on every dispatch.                                                |
| 4. Safety and recall           | Exercise existing `recall` search/expansion and current-policy validation against retained segment sources. Keep source provenance and exact request artifacts in normal receipts/manifests.                                                                                                  | Corrections, deletion, forget, exclusions, team scope, child scope and mid-turn policy changes suppress stale content before the next dispatch/effect. No mutation is repeated to rebuild context; failed checkpoints retain valid history.                                   |
| 5. Main date UI                | Extend `apps/web/src/App.tsx` transcript rendering and the History timezone preference through shared UI state. Preserve ACP transport and immutable message identity.                                                                                                                        | jsdom/fake ACP tests cover midnight, DST, timezone changes, spanning turns, pagination joins, streaming, drafts and scroll/focus. Use agent-browser for desktop/mobile visual verification. This phase can ship independently.                                                |
| 6. Evaluation and rollout      | Compare current assembly, a per-request sliding window and stable bounded segments on identical synthetic conversations, then opt-in real-provider trials. Pin model/price/configuration and include cold, warm, expired-cache and post-compaction cases.                                     | Report continuity, historical recall, unrelated-topic contamination, correction/forget behavior, total cost per successful task and latency. Enable incrementally only with reviewed evidence; mechanism tests alone establish no general quality/cost improvement.           |

Initial experiments must include an overnight follow-up, unrelated next-day
request, continuous work across midnight, a large prior answer requiring exact
expansion, interrupted work and repeated compactions. Choose token budgets and
rebuild thresholds from the configured model window and measured results; this
design does not invent a fixed turn count, idle timeout or target cache-hit ratio.
Runtime rollout requires relevant unit/integration tests, repository lint and
typecheck; UI rollout additionally requires the listed browser verification.
