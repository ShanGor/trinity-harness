# Memory evolution evaluation — 2026-11-24

The checkout implements the opt-in mechanisms, including automatic bounded fact
selection and explicitly delegated nightly equivalent-fact merging. Local Ollama
results below measure synthetic histories only; deployed acceptance and production
readiness remain separate. Migration 0028 is now applied to the configured database;
no application deployment or account/schedule setting was changed.

## Reproducible deterministic baseline

Suite: `packages/memory/test/eval`, synthetic history only. Five episodes and six
QA cases cover literal recall, changed preference/location, time, paraphrase,
Chinese/English retrieval and an unsupported negative query. Score is top-one
retrieval correctness (or an empty result for the negative case), **not answer
accuracy**.

| Retrieval                                       | Correct | Interpretation                                                                             |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Existing `PgConversationIndex.history` ILIKE    | 3/6     | Measured against PostgreSQL 16 in an isolated pgvector container                           |
| Literal fixture mirroring the ILIKE terms/order | 3/6     | Deterministic CI baseline                                                                  |
| RRF + decay with gold fake vector candidates    | 6/6     | Mechanism test; vectors encode the expected answer and do not demonstrate semantic quality |

The fake-vector result is deliberately not reported as a real-model improvement.
The deployment default remains off. When enabled, bounded related active facts may
be selected automatically; equivalent accepted facts can merge only under an
explicit schedule-owner delegation. Candidates and playbooks never activate automatically.

## Mechanism gates

- PG tests cover append-only journals, idempotency after adapter recreation/retry,
  atomic acceptance/rollback, concurrent CAS decisions, exact original unquoted
  provenance, owner/exclusion/removal/settings/occurrence fences, fact correction,
  anti-resurrection, reviewed playbooks, vector claims and model/date/policy filters.
- Fake-LLM tests verify complete recall pairs, v3 fact receipts before dispatch and
  context invalidation before subsequent model requests. Baseline conversations
  remain usable if the unused evolution adapter is unavailable.
- UI tests verify pending decisions, retry operation IDs and preservation of an
  unsaved Persona while reviewing suggestions.
- SDK transport tests verify quota failure, final source validation, secret-free
  usage and no environment fallback after database configuration activation.

Run mechanisms against a **disposable** migrated PostgreSQL 16 + pgvector database:

```sh
DATABASE_URL="$TRINITY_MEMORY_TEST_DATABASE_URL" pnpm db:migrate
TRINITY_MEMORY_TEST_DATABASE_URL="$TRINITY_MEMORY_TEST_DATABASE_URL" pnpm test packages/db/test/memory-evolution.test.ts
pnpm test packages/memory/test apps/server/test/memory-evolution-loop.test.ts apps/server/test/memory-evolution-api.test.ts apps/web/test/memory-evolution.test.ts packages/core/test/embedding-gateway.test.ts
```

The implementation run used a temporary rootless `pgvector/pgvector:pg16` container.
The initial configured-database migration failed; the continuation diagnosed and
resolved that prerequisite as recorded below. This is not evidence of application deployment.

## Initial implementation verification

- Full `pnpm test`: **1,980 passed, 45 skipped** (200 passing files, 12 gated/skipped files), using isolated PostgreSQL 16 + pgvector and Redis 7 containers. Application baseline tests and memory integration tests used separate disposable databases.
- `pnpm typecheck`, `pnpm lint`, changed-file Prettier checks, `git diff --check` and evaluation-runner shell syntax checks passed.
- Web production build passed, retaining the existing large-chunk warning.
- A temporary browser fixture verified suggestion acceptance and unsaved Persona preservation; jsdom tests also cover exact fact/playbook disclosures. This does not certify the deployed application or real account behavior.
- A slow-embedding test verifies that scheduling continues independently and both loops drain on cancellation before database disposal.
- Helm rendering was not run because the local Helm CLI is unavailable; deployed configuration consistency remains an open release gate.
- Temporary browser/Vite fixtures were removed. Disposable database/Redis containers are stopped after verification; repository fixtures and this evidence remain. No production deployment or Git commit was performed.

## Continuation verification and configured migration

- Full regression: **2,006 passed, 46 skipped** (202 passing files, 12 gated/skipped),
  with separate disposable baseline/memory PostgreSQL 16 + pgvector databases and Redis 7.
- Four additional Node tests exercise evaluation-database preflight. Lint, workspace
  typechecks, changed-file formatting, shell syntax, `git diff --check` and Web build
  passed. The existing large-chunk warning remains.
- Deterministic coverage includes five-fact/8 KiB automatic selection, personal/team
  separation, adapter-failure baseline, cancellation, source/revision revalidation,
  explicit merge delegation, equivalent wording, atomic lineage, idempotent adapter
  recreation, auto-save opt-out and source revocation. Loop cases verify complete
  merge results before receipts, old recall retirement, concurrent changes and a
  lost response after the durable merge without repeating the mutation.
- New poisoning admission cases reproduced an indented-code source bypass; indented
  and tab-indented code are now rejected alongside fenced/inline/quoted sources.
- Agent-browser fixture checks confirmed default-unchecked merge delegation, its
  exact submitted true value after explicit selection, multi-source disclosure and
  automatic-selection labeling. The settled 390px layout had no horizontal overflow.
  These were fake-client checks, not authenticated deployed-account acceptance.
- The configured PostgreSQL is 18.6. pgvector was available but not installed, and
  the migration role could not create its untrusted extension. The human installed
  pgvector **0.8.1** through administrator authentication; `pnpm db:migrate` then
  succeeded (29 migration records, through 0028). Evolution owners remained zero.
  Application containers were still running; no images were replaced, feature
  configuration enabled or Git commit made.

## Local Ollama real-provider results

Both available embedding models were tested via `AiSdkEmbeddingGateway`, the
constrained SDK transport, durable claims, real pgvector search and usage events.
Only synthetic data went to the local Ollama endpoint. A temporary loopback-only
TLS forwarder preserved the existing HTTPS-only policy; no insecure transport
exception, live tenant credential copy or permanent provider configuration was added.

| Current runtime encoding                       | Original six | Additional eleven | Total top-one correctness |
| ---------------------------------------------- | ------------ | ----------------- | ------------------------- |
| PostgreSQL lexical baseline                    | 3/6          | 3/11              | 6/17                      |
| Ollama `bge-m3:latest`, 1024 dimensions        | 6/6          | 11/11             | **17/17**                 |
| Ollama `qwen3-embedding:0.6b`, 1024 dimensions | 5/6          | 11/11             | **16/17**                 |

Both models retrieved all five cross-language cases and rejected all three unrelated
negative queries. Qwen missed one current-location question. This is retrieval
correctness on five synthetic episodes, not answer accuracy, broad model superiority
or calibrated production quality. The additional phrases are a regression set,
not a large independent benchmark. Qwen was tested with the runtime's raw query
encoding; its [model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) recommends
query instructions, so this does not compare optimally configured models.

Before the hybrid lexical repair, BGE scored 5/6 and Qwen 4/6. OR-ILIKE treated
functional words such as `I` and `do` (also matching `dog`) as lexical hits that
competed with correct semantic results. Hybrid-only functional-term filtering
fixed this without changing the disabled, paginated or provider-failure baseline.
The runner now uses a fixed ranking clock, reports category/suite counts and fails
on category regression, missing hybrid capability or negative-query false recall.
Real-vector exclusion and cross-owner checks passed after source revocation.

### Real response poisoning matrix

The final `memory-poisoning-v2` run used Ollama **`qwen3.5:9b`** through the SDK
gateway and ordinary Loop with quota/usage persistence. English/Chinese payloads
were delivered through original episode reads, active fact reads and automatic
fact selection: **6/6 received the payload, ignored its directive and included the
expected factual answer**. Actual source reads and complete persisted pairs force
delivery for the recall cases; automatic cases use the production selection path.
This separates response behavior from autonomous tool-selection success. The
available tool catalog contained only recall, so it is not an unrestricted
external-effect or data-exfiltration evaluation. Scoring checks a bounded expected
answer string and absence of the attack marker, not general semantic correctness.

Earlier runs are not discarded: Gemma `gemma4:e2b` did not call recall in 4/4
autonomous cases; an early Qwen run read 3/4. With forced delivery, Qwen initially
answered 5/6 correctly, over-refusing one authorized personal-fact question; it did
not follow the injection. The final run followed a concrete guidance change:
ignore embedded instructions, use supported factual portions and do not refuse
already authorized personal data solely because it is personal. SDK compatibility
warnings exposed synthetic reasoning during evaluation; raw default warning logging
is now disabled, preserving explicitly installed operator loggers.

These small local matrices do not satisfy broad adversarial, candidate extraction,
consenting-account or representative-scale production acceptance. Automatic merging
is deliberately limited to same-kind NFC/whitespace-equivalent accepted wording;
semantic paraphrase merging and contradiction resolution remain reviewed proposals.

## Reproducing the opt-in gates

`scripts/evaluate-memory.sh` requires an empty disposable database, an explicitly
selected `MEMORY_EMBEDDING_MODEL`, and configured credentials/provider destinations.
It checks the target **before migrating**, rejects the configured application database
(including aliases) and any populated application table, then migrates the disposable
database, creates synthetic owner/history, embeds
through the existing SDK/credential/egress/quota/usage infrastructure and compares
lexical and hybrid results. The runner refuses a nonempty database. It prints only
suite IDs and counts/booleans, and fails on embedding unavailability or retrieval regression.
Use a fresh database for each run. It incurs provider usage when explicitly run.

```sh
TRINITY_MEMORY_TEST_DATABASE_URL=... \
MEMORY_EMBEDDING_MODEL=openai/text-embedding-3-small \
./scripts/evaluate-memory.sh
```

Optionally set `MEMORY_EVALUATION_CHAT_MODEL=openai/<model>` to include the six-case
response-poisoning matrix. Its synthetic route uses explicit `OPENAI_BASE_URL`,
`OPENAI_API_KEY` and the operator destination rules; do not copy live tenant secrets
into evaluation databases. Self-hosted Ollama supports the
[OpenAI-compatible embedding API](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx).
The configured application database must be reachable for identity comparison;
preflight fails closed if it cannot establish separation. Never share the disposable
database with concurrent writers. SDK calls may incur provider usage.

Candidate acceptance/false-positive rates on consenting accounts, latency at
representative scale and broader adversarial behavior remain unmeasured.
Candidate acceptance target: at least 90% on a
reviewed synthetic gold set, with zero unauthorized/unsupported activations in the
deterministic admission matrix; do not treat mechanical provenance as claim support.
Keep deployment off until the remaining rollout gates pass. Retain source revocation,
contradiction and poisoning checks when changing automatic selection or expanding
merge semantics. No new deployment switches were added. Task-created browser/Vite/TLS
fixtures were removed and the disposable database/Redis containers stopped after verification.
