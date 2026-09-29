# Trinity Harness

Enterprise-grade, multi-user, browser ↔ server AI Agent platform — core scenario: software engineering agents (coding, debugging, refactoring, code review).

> Status: **M5** (production: tenant token quotas, OTel observability, sandbox env scrubbing, Docker images + Helm chart with HPA/Ingress/NetworkPolicy, load test). Roadmap and architecture: [`docs/design.md`](docs/design.md). Progress: [`docs/project-progress.md`](docs/project-progress.md). Release gate: [`docs/production-checklist.md`](docs/production-checklist.md). Agent behavior rules: [`AGENTS.md`](AGENTS.md).

## What works today (M5 = M4 + production hardening)

- **Agent Loop** — turn/step driver with streaming LLM output, a parallel tool pool (`maxParallelTools`, `exclusive` tools), abort handling, and an event-sourced session log (everything replayable).
- **PG event sourcing** — the loop persists into PostgreSQL `session_events` (append-only, hash-chained, monotonic seq, per-session advisory lock); the PG log is the single source of truth.
- **Context compaction (M4)** — a Context Manager checks context pressure before every model call and between steps; over budget, the oldest _whole exchanges_ are LLM-summarized into an append-only `compaction/summary` event whose range replaces the surface **in place** (history is never deleted; boundaries snap to message/tool pairs so the current prompt is never compacted).
- **Tool-result spill (M4)** — results above `SPILL_THRESHOLD_BYTES` go to the BlobStore; the log keeps a `blob://` reference + preview, retrievable via the `read_blob` tool.
- **LSP (M4)** — lazy per-workspace language servers (Python/TS/JSON/YAML) spawned via the `SandboxPort`; `lsp_diagnostics` / `lsp_symbols` / `lsp_hover` / `lsp_rename` tools plus automatic diagnostics injection into the system prompt each step (files seen in recent tool calls, capped). Requires the language servers on the server/worker PATH (`pyright-langserver`, `typescript-language-server`, …); note `typescript-language-server` also needs a resolvable `typescript` install in the analyzed workspace. Verified against real pyright/tsserver processes (see `packages/core/test/lsp-real.test.ts`, auto-skips when servers are absent).
- **Subagent (M4)** — a `subagent` tool runs a child loop with a fresh in-memory context (capped steps, no nested subagents) and returns only the final report to the parent.
- **Multimodal (M4)** — the web UI attaches images/PDFs (uploaded to the BlobStore); PDFs get text-extracted (`pdf-parse`) with the extraction stored as a companion blob; prompts carry `blob://` content blocks end-to-end (REST + ACP, incl. inline base64 resources) into provider-native image/file parts; the event log only stores references.
- **Redis distribution** — per-session Streams with seq-aligned ids (`sess:<id>`), a global `audit` stream, Pub/Sub live deltas, and BullMQ turn queue between `server` and `agent-worker`.
- **SSE resume** — stream events carry `id: <seq>`; reconnects via `Last-Event-ID` / `?afterSeq=` are gap-filled from PG and switched to the live stream (docs/design.md §11.3).
- **Auth / tenants / RBAC** — scrypt password hashing, HMAC bearer tokens, roles `admin` / `developer` / `viewer`; sessions are tenant-owned; viewers are read-only; audit query is admin-only.
- **Audit** — logins, session creation, prompts and tool invocations are published to the `audit` stream and persisted by the standalone `audit-consumer` into `audit_log` (idempotent, at-least-once).
- **Tools** — `read_file`, `write_file`, `edit_file` (exact-match str-replace), `glob`, `bash`, `read_blob`, `lsp_*`, `subagent` — all routed through a `SandboxPort`.
- **Web UI** — React 19 + Ant Design 5 + Ant Design X chat; sign-in screen, streaming bubbles, tool-call cards, image/PDF attachments, admin audit tab.
- **Permission presets** — per-session policy (`workspace-write + ask` default, `read-only`, `danger-full-access + never`) stored on the session; `bash` commands classified lexical-only, workspace-internal commands run free under the default preset.
- **Human approval flow** — gated tool calls block the turn and push a `permission_request` to every connected UI; answers travel back over Redis Pub/Sub (fail-closed: no listener/timeout ⇒ rejected); request + outcome are committed to the event log (`approval/requested`, `approval/resolved`) and the `approvals` table, and audited.
- **ACP HTTP binding** — `POST /acp` (JSON-RPC) + `GET /acp/stream` (SSE of JSON-RPC messages, seq ids) on the server; `session/prompt` holds until the turn ends (ACP semantics); `session/cancel`, `session/set_config_option`, `session/load` supported.
- **acp-gateway** — stdio ACP process (`apps/acp-gateway`, official `@agentclientprotocol/sdk`) for Zed et al.; translates to the server's HTTP binding, bridges `session/request_permission` to the editor client.
- **Token quotas (M5)** — the loop records per-request token usage into `model_usage` and gates every model call on the tenant quota (hour/day/month windows, fail-closed: over limit or a store error denies before tokens are spent, with a friendly `turn/end` message). Admins set limits via `PUT /api/admin/quota`; usage shows on `GET /api/usage`; changes are audited.
- **Observability (M5)** — OTel spans (`trinity.turn/step/tool/approval`) + metrics (token consumption, tool success rate, approval latency, turn duration, BullMQ queue depth) via `@opentelemetry/api`; enable by setting `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP) or `OTEL_PROMETHEUS_PORT` (Prometheus `/metrics`) on server / agent-worker / audit-consumer.
- **Sandbox hardening (M5)** — spawned shells/processes get a scrubbed env by default (`SANDBOX_ENV_MODE=minimal`): model API keys and server secrets never reach tool children. `inherit` exists for local convenience only.
- **Kubernetes (M5)** — `deploy/docker/*.Dockerfile` images and the `deploy/helm/trinity-harness` chart: server HPA 2–20 + PDB, agent-worker HPA 1–50 (KEDA for queue-depth 0→N, see the checklist), hardened `securityContext`, default-deny egress NetworkPolicy with allowlist, gVisor `runtimeClassName` option for the worker, Ingress with SSE buffering disabled. Release gate: [`docs/production-checklist.md`](docs/production-checklist.md).
- **Load test (M5)** — `pnpm load:test` (`scripts/load-test.mjs`): auth / prompt-enqueue / SSE-replay-fan-out phases with p50/p95/p99 and an error-rate gate, runnable against any deployed instance.

## Quick start

Prerequisites: **Node.js ≥ 22.12**, **pnpm 11+**, **PostgreSQL 16+**, **Redis 7+** (local testing env).

```bash
# 1. Install dependencies
pnpm install

# 2. Configure the environment
cp .env.example .env
#   - DATABASE_URL: defaults to the local trinity_harness test DB
#   - REDIS_URL:    defaults to redis://localhost:6379
#   - TOKEN_SECRET / ADMIN_EMAIL / ADMIN_PASSWORD: first-boot auth bootstrap
#   - ANTHROPIC_API_KEY (or OPENAI_API_KEY when using "openai/..." models)

# 3. Apply database migrations (Drizzle Kit)
pnpm db:migrate

# 4. Run the topology (three processes)
pnpm dev:server    # API + SSE relay + /acp  (http://127.0.0.1:3000)
pnpm dev:worker    # agent loop consumer
pnpm dev:audit     # audit consumer

# 5. In another terminal, run the web UI (http://localhost:5173)
pnpm dev:web
```

Open http://localhost:5173, sign in with the bootstrap admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`), and describe a coding task. The agent can read/write/edit files and run shell commands inside `WORKSPACE_ROOT` (defaults to the repo root). Sign in as `admin` to see the **Audit** tab.

## Configuration (`.env`)

| Variable                          | Required                   | Default                                                                       | Purpose                                                                  |
| --------------------------------- | -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                    | for PG store / migrations  | `postgresql://trinity_harness:trinity_harness@localhost:5432/trinity_harness` | PostgreSQL connection                                                    |
| `REDIS_URL`                       | for distributed mode (M2)  | —                                                                             | Redis 7+ connection (streams, Pub/Sub, BullMQ)                           |
| `TOKEN_SECRET`                    | when `DATABASE_URL` is set | —                                                                             | HMAC key for bearer tokens (min 16 chars)                                |
| `ADMIN_EMAIL`                     | no                         | `admin@trinity.local`                                                         | First-boot bootstrap admin email                                         |
| `ADMIN_PASSWORD`                  | first boot only            | —                                                                             | First-boot bootstrap admin password (min 8 chars)                        |
| `ANTHROPIC_API_KEY`               | for `anthropic/...` models | —                                                                             | Anthropic API key (server-side only)                                     |
| `ANTHROPIC_BASE_URL`              | no                         | —                                                                             | Custom Anthropic-compatible endpoint                                     |
| `OPENAI_API_KEY`                  | for `openai/...` models    | —                                                                             | OpenAI API key (server-side only)                                        |
| `OPENAI_BASE_URL`                 | no                         | —                                                                             | Custom OpenAI-compatible endpoint                                        |
| `MODEL`                           | no                         | `anthropic/claude-sonnet-4-20250514`                                          | Model in `provider/model-id` form                                        |
| `REASONING_BUDGET_TOKENS`         | no                         | —                                                                             | Anthropic extended-thinking budget (tokens)                              |
| `REASONING_EFFORT`                | no                         | —                                                                             | OpenAI reasoning effort (`low`/`medium`/`high`/…)                        |
| `PORT` / `HOST`                   | no                         | `3000` / `127.0.0.1`                                                          | Server listen address                                                    |
| `WORKSPACE_ROOT`                  | no                         | cwd                                                                           | Directory the agent sandbox is rooted at                                 |
| `SYSTEM_PROMPT`                   | no                         | `You are Trinity…`                                                            | System prompt for the loop                                               |
| `DEFAULT_PERMISSION_POLICY`       | no                         | `workspace-write`                                                             | M3: preset name or JSON policy for new sessions                          |
| `ACP_SERVER_URL` / `ACP_TOKEN`    | for acp-gateway            | `http://127.0.0.1:3000` / —                                                   | M3: server HTTP binding + bearer for the gateway                         |
| `CONTEXT_MAX_TOKENS`              | no                         | `160000`                                                                      | M4: projected-context budget before compaction                           |
| `CONTEXT_KEEP_TOKENS`             | no                         | `40000`                                                                       | M4: retained recent-context floor when compacting                        |
| `COMPACTION_MODEL`                | no                         | = `MODEL`                                                                     | M4: summarizer model                                                     |
| `SPILL_THRESHOLD_BYTES`           | no                         | `50000`                                                                       | M4: tool results above this spill to the BlobStore                       |
| `LSP_ENABLED` / `LSP_MAX_SERVERS` | no                         | `true` / `4`                                                                  | M4: language servers + per-process pool ceiling                          |
| `SANDBOX_ENV_MODE`                | no                         | `minimal`                                                                     | M5: `minimal` scrubs secrets from tool children; `inherit` is local-only |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | no                         | —                                                                             | M5: OTLP/gRPC endpoint for traces + metrics                              |
| `OTEL_PROMETHEUS_PORT`            | no                         | —                                                                             | M5: serve Prometheus `/metrics` on this port                             |

Server modes (auto-selected in `apps/server/src/main.ts`): `DATABASE_URL` + `REDIS_URL` → **distributed** (BullMQ turns run on `agent-worker`; SSE relayed via Redis Streams); `DATABASE_URL` only → PG event log with the loop in-server; neither → M1 in-memory inline mode (tests/local fallback). `REDIS_URL` without `DATABASE_URL` is rejected (fail-closed: distributed mode needs the PG event log).

Secrets live server-side only: they are never sent to the frontend and never logged into event payloads.

## Scripts

| Command                                              | Purpose                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm dev:server` / `pnpm dev:web`                   | Dev servers (tsx watch / vite)                                        |
| `pnpm dev:worker` / `pnpm dev:audit`                 | M2 consumers (agent loop / audit persistence)                         |
| `pnpm dev:gateway`                                   | M3: stdio ACP gateway (point Zed at it)                               |
| `pnpm test`                                          | Vitest — unit + integration (DB/Redis tests auto-skip if unreachable) |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Quality gates (all must pass)                                         |
| `pnpm db:generate` / `pnpm db:migrate`               | Drizzle Kit migration workflow (`generate` → review SQL → `migrate`)  |
| `pnpm load:test`                                     | M5 load test against a running server (see `scripts/load-test.mjs`)   |

## Deploying (M5)

```bash
# Build images (from the repo root)
docker build -f deploy/docker/Dockerfile.server -t trinity-harness/server:0.5.0 .
docker build -f deploy/docker/Dockerfile.agent-worker -t trinity-harness/agent-worker:0.5.0 .
docker build -f deploy/docker/Dockerfile.audit-consumer -t trinity-harness/audit-consumer:0.5.0 .
docker build -f deploy/docker/Dockerfile.web -t trinity-harness/web:0.5.0 .

# Install (external PostgreSQL 16+ / Redis 7+ required)
helm upgrade --install trinity deploy/helm/trinity-harness \
  --set secrets.databaseUrl=... --set secrets.redisUrl=... \
  --set secrets.tokenSecret=... --set secrets.adminPassword=...
```

Walk [`docs/production-checklist.md`](docs/production-checklist.md) before going live
(quota config, OTel endpoints, KEDA for queue-depth scaling, NetworkPolicy allowlists, gVisor).

## Architecture (M2)

```
apps/web (React+antd) ──HTTP/SSE──> apps/server (Fastify, enqueue-only) ──BullMQ──> apps/agent-worker (Loop)
       ▲  ▲                            │  ▲  ▲                                       │
       │  └──── SSE relay (Redis       │  │  └──── /acp HTTP binding (JSON-RPC+SSE) │ approval
       │       Streams + Pub/Sub)      │  │            ▲                             ▼ channel
       │       seq ids + afterSeq      │  └──── PG session_events (source of truth) ◄┘
       └──── client-acp (Last-Event-ID)│        append-only, hash-chained, seq-aligned
Zed ──stdio──> apps/acp-gateway ───────┘        + approvals table (M3 留痕)
                                          apps/audit-consumer ──consumes──▶ audit stream ──▶ audit_log
packages/contracts ← all ports · packages/redis (EventBus, SessionStream, TurnQueue, ApprovalHub)
```

Hard rules (see `AGENTS.md` §3): modules communicate **only** through `packages/contracts` interfaces; the object graph is assembled exclusively at app composition roots; tools never touch `child_process`/FS directly — only via `SandboxPort`; the event log is append-only; PG is the single source of truth — Redis streams are a loss-tolerant distribution layer.

## Roadmap

M0 monorepo + PG foundation ✅ · M1 minimal loop ✅ · M2 PG event sourcing + Redis bus + BullMQ + auth/RBAC + audit ✅ · M3 ACP HTTP binding + acp-gateway + approvals + permission presets ✅ · M4 LSP + compaction + subagents + multimodal ✅ · **M5 quotas + OTel + sandbox hardening + Helm/Docker + load test ✅** · M6 extensibility — details in `docs/design.md` §18.
