# Memory evolution evaluation — 2026-11-24

The checkout implements the opt-in mechanisms. Real-provider quality, deployed
acceptance and production readiness remain separate gates. No production service
or account setting was changed by this implementation.

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
Current default: no automatic archival fact injection, no automatic fact merging,
no automatically activated candidates or playbooks.

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
Applying migrations to the existing configured database failed without a diagnostic;
that environment was not changed or used as evidence of successful deployment.

## Final implementation verification

- Full `pnpm test`: **1,980 passed, 45 skipped** (200 passing files, 12 gated/skipped files), using isolated PostgreSQL 16 + pgvector and Redis 7 containers. Application baseline tests and memory integration tests used separate disposable databases.
- `pnpm typecheck`, `pnpm lint`, changed-file Prettier checks, `git diff --check` and evaluation-runner shell syntax checks passed.
- Web production build passed, retaining the existing large-chunk warning.
- A temporary browser fixture verified suggestion acceptance and unsaved Persona preservation; jsdom tests also cover exact fact/playbook disclosures. This does not certify the deployed application or real account behavior.
- A slow-embedding test verifies that scheduling continues independently and both loops drain on cancellation before database disposal.
- Helm rendering was not run because the local Helm CLI is unavailable; deployed configuration consistency remains an open release gate.
- Temporary browser/Vite fixtures were removed. Disposable database/Redis containers are stopped after verification; repository fixtures and this evidence remain. No production deployment or Git commit was performed.

## Opt-in real-provider gate — not run

`scripts/evaluate-memory.sh` requires an empty disposable database, an explicitly
selected `MEMORY_EMBEDDING_MODEL`, and configured credentials/provider destinations.
It migrates that disposable database, creates a synthetic owner/history, embeds
through the existing SDK/credential/egress/quota/usage infrastructure and compares
lexical and hybrid results. The runner refuses a nonempty database. It prints only
suite IDs and counts, and fails on embedding unavailability or retrieval regression.
Use a fresh database for each run. It incurs provider usage when explicitly run.

```sh
TRINITY_MEMORY_TEST_DATABASE_URL=... \
MEMORY_EMBEDDING_MODEL=openai/text-embedding-3-small \
./scripts/evaluate-memory.sh
```

No configured real embedding model was selected for this implementation run.
Real-provider cross-language/paraphrase quality, candidate acceptance/false-positive
rates on consenting accounts, latency at representative scale and adversarial
model behavior remain unmeasured. Candidate acceptance target: at least 90% on a
reviewed synthetic gold set, with zero unauthorized/unsupported activations in the
deterministic admission matrix; do not treat mechanical provenance as claim support.
Automatic injection and sleep-time merging stay deferred until their own poisoning,
contradiction and source-revocation evaluations pass. There is no enable switch for
these unimplemented experiments.
