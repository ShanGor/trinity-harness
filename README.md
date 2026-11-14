# Trinity Harness

Enterprise-grade, multi-user, browser ↔ server general-purpose AI Agent platform. Software engineering (coding, debugging, refactoring, code review) is a first-class task domain alongside research and other specialist work.

> Status: **M5** (production: tenant token quotas, OTel observability, sandbox env scrubbing, Docker images + Helm chart with HPA/Ingress/NetworkPolicy, load test). Roadmap and architecture: [`docs/design.md`](docs/design.md). Progress: [`docs/project-progress.md`](docs/project-progress.md). Release gate: [`docs/production-checklist.md`](docs/production-checklist.md). Agent behavior rules: [`AGENTS.md`](AGENTS.md).

## What works today (M5 = M4 + production hardening)

- **Agent Loop** — turn/step driver with streaming LLM output, a parallel tool pool (`maxParallelTools`, `exclusive` tools), abort handling, and an event-sourced session log (everything replayable).
- **PG event sourcing** — the loop persists into PostgreSQL `session_events` (append-only, hash-chained, monotonic seq, per-session advisory lock); the PG log is the single source of truth.
- **Context compaction (M4)** — a Context Manager checks context pressure before every model call and between steps; over budget, the oldest _whole exchanges_ are LLM-summarized into an append-only `compaction/summary` event whose range replaces the surface **in place** (history is never deleted; boundaries snap to message/tool pairs so the current prompt is never compacted).
- **Tool-result spill (M4)** — results above `SPILL_THRESHOLD_BYTES` go to the BlobStore; the log keeps a `blob://` reference + preview, retrievable via the `read_blob` tool.
- **LSP (M4)** — lazy per-workspace language servers (Python/TS/JSON/YAML) spawned via the `SandboxPort`; `lsp_diagnostics` / `lsp_symbols` / `lsp_hover` / `lsp_rename` tools plus automatic diagnostics injection into the system prompt each step (files seen in recent tool calls, capped). Requires the language servers on the server/worker PATH (`pyright-langserver`, `typescript-language-server`, …); note `typescript-language-server` also needs a resolvable `typescript` install in the analyzed workspace. Verified against real pyright/tsserver processes (see `packages/core/test/lsp-real.test.ts`, auto-skips when servers are absent).
- **Subagent (M4)** — a `subagent` tool runs a child loop with a fresh in-memory context (optional step ceiling, no nested subagents) and returns only the final report to the parent.
- **Multimodal (M4)** — the web UI attaches images/PDFs (uploaded to the BlobStore); PDFs get text-extracted (`pdf-parse`) with the extraction stored as a companion blob; prompts carry `blob://` content blocks end-to-end (REST + ACP, incl. inline base64 resources) into provider-native image/file parts; the event log only stores references.
- **Redis distribution** — per-session Streams with seq-aligned ids (`sess:<id>`), a global `audit` stream, Pub/Sub live deltas, and BullMQ turn queue between `server` and `agent-worker`.
- **SSE resume** — stream events carry `id: <seq>`; reconnects via `Last-Event-ID` / `?afterSeq=` are gap-filled from PG and switched to the live stream (docs/design.md §11.3).
- **Auth / tenants / RBAC** — scrypt password hashing, HMAC bearer tokens, roles `admin` / `developer` / `viewer`; sessions are tenant-owned; viewers are read-only; audit query is admin-only.
- **Audit** — logins, session creation, prompts and tool invocations are published to the `audit` stream and persisted by the standalone `audit-consumer` into `audit_log` (idempotent, at-least-once).
- **Tools** — `read_file`, `write_file`, `edit_file` (exact-match str-replace), `glob`, `bash`, `read_blob`, `lsp_*`, `subagent` — all routed through a `SandboxPort`.
- **Web UI** — React 19 + Ant Design 5 + Ant Design X chat; sign-in screen, streaming bubbles, tool-call cards, image/PDF attachments, admin audit tab.
- **Permission presets** — per-session policy (`workspace-write + ask` default for Main Chat, side Chat and Work, `read-only`, `danger-full-access + never`) stored on the session; listed sensitive files still require agent approval under every preset, and workspace-internal Bash commands run free under the default preset.
- **Human approval flow** — gated tool calls block the turn and push a `permission_request` to every connected UI; answers travel back over Redis Pub/Sub (fail-closed: no listener/timeout ⇒ rejected); request + outcome are committed to the event log (`approval/requested`, `approval/resolved`) and the `approvals` table, and audited.
- **ACP HTTP binding** — `POST /acp` (JSON-RPC) + `GET /acp/stream` (SSE of JSON-RPC messages, seq ids) on the server; `session/prompt` holds until the turn ends (ACP semantics); `session/cancel`, `session/set_config_option`, `session/load` supported.
- **acp-gateway** — stdio ACP process (`apps/acp-gateway`, official `@agentclientprotocol/sdk`) for Zed et al.; translates to the server's HTTP binding, bridges `session/request_permission` to the editor client.
- **Token quotas (M5)** — the loop records per-request token usage into `model_usage` and gates every model call on the tenant quota (hour/day/month windows, fail-closed: over limit or a store error denies before tokens are spent, with a friendly `turn/end` message). Admins set limits via `PUT /api/admin/quota`; usage shows on `GET /api/usage`; changes are audited.
- **Observability (M5)** — OTel spans (`trinity.turn/step/tool/approval`) + metrics (token consumption, tool success rate, approval latency, turn duration, BullMQ queue depth) via `@opentelemetry/api`; enable by setting `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP) or `OTEL_PROMETHEUS_PORT` (Prometheus `/metrics`) on server / agent-worker / audit-consumer.
- **Sandbox hardening (M5)** — spawned shells/processes get a scrubbed env by default (`SANDBOX_ENV_MODE=minimal`): model API keys and server secrets never reach tool children. `inherit` exists for local convenience only.
- **Kubernetes (M5)** — `deploy/docker/*.Dockerfile` images and the `deploy/helm/trinity-harness` chart: server HPA 2–20 + PDB, agent-worker HPA 1–50 (KEDA for queue-depth 0→N, see the checklist), hardened `securityContext`, default-deny egress NetworkPolicy with allowlist, gVisor `runtimeClassName` option for the worker, Ingress with SSE buffering disabled. Release gate: [`docs/production-checklist.md`](docs/production-checklist.md).
- **Load test (M5)** — `pnpm load:test` (`scripts/load-test.mjs`): auth / prompt-enqueue / SSE-replay-fan-out phases with p50/p95/p99 and an error-rate gate, runnable against any deployed instance.

## Run the deployed single-host stack

Use this path for an existing Podman deployment. Run commands from the repository root as the same unprivileged user who deployed it. PostgreSQL, Redis and the provisioned Firecracker Node Agent are separate host services. Initial setup requires Node.js 22.12+, pnpm 11+, Podman, Cargo, the Bifrost Bridge checkout, and the [Firecracker host and guest prerequisites](deploy/firecracker/README.md).

| Task                                             | Command                                | Applies changes?                                                   |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------ |
| Install or update application code/configuration | `./scripts/deploy-podman.sh`           | Builds images, applies migrations and replaces all five containers |
| Start existing containers                        | `./scripts/podman-services.sh start`   | Uses their saved configuration                                     |
| Restart existing containers                      | `./scripts/podman-services.sh restart` | Restarts the same containers; no rebuild or migration              |
| Stop application containers                      | `./scripts/podman-services.sh stop`    | Keeps containers and data; leaves Node Agent and guests running    |
| Inspect container state                          | `./scripts/podman-services.sh status`  | Reports process state only                                         |

For first installation, run `pnpm install`, create `.env` from `.env.example` once, configure credentials and the matching host runtime, then run `./scripts/deploy-podman.sh`. This packaging requires `EXECUTION_DRIVER=firecracker` and `BROWSER_DRIVER=zendriver`. Keep an existing `.env`; startup uses `ADMIN_EMAIL`/`ADMIN_PASSWORD` to bootstrap an account only when no users exist.

Open **http://localhost:8080** (or your configured `WEB_PORT`) and sign in. The deployment runs `trinity-browser-runtime`, `trinity-server`, `trinity-agent-worker`, `trinity-audit-consumer` and `trinity-gateway`. It starts an inactive installed Node Agent if needed, but does not restart an active Node Agent or replace guest images.

Keep one supervisor for each deployed service. Stop IDE run configurations and `pnpm dev:*` watchers for this deployment before using Podman. In particular, `pnpm dev:browser-runtime` must not replace or run alongside the deployed Browser Runtime on port 3010. Separate development environments need separate ports, databases, queues and runtime assignments.

### Check application and guest readiness

```bash
./scripts/podman-services.sh status
curl --fail http://127.0.0.1:8080/api/health
systemctl is-active trinity-node-agent.service
podman logs --tail 50 trinity-browser-runtime
podman logs --tail 50 trinity-agent-worker
```

Use your configured web port in the health URL. Start/restart also checks authenticated Node Agent and Browser Runtime request validation. These checks establish service readiness; they do not prove that a guest boots, its RPC connection works, or a browser page can be read. Verify those separately through an authenticated session: check the VM sidebar, request a fresh page read, and inspect the terminal result. A `running` VM or a guest console's RPC-ready marker alone is insufficient.

If a turn remains on **“I’m getting your PC ready. This may take a moment…”**, inspect its terminal error and guest routing rather than repeatedly restarting application containers. That message is a progress notification, not a readiness receipt. See [runtime diagnostics and recovery](docs/runtime-implementation.md) and [Firecracker operation and recovery](deploy/firecracker/README.md#operation-and-recovery).

### Apply the correct kind of update

| Change                                                                             | Required delivery                                                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Application TypeScript, web bundle, dependencies or deployment `.env`              | `./scripts/deploy-podman.sh`; `restart` retains old images and saved configuration                                                        |
| Guest runtime code, bundled guest skills/dependencies, Chrome or patched Zendriver | Prepare a fresh guest payload, build and test a new immutable guest image, install through node maintenance, then wake a fresh generation |
| Host Node Agent, launcher or networking                                            | Follow the host maintenance release procedure; application restart does not upgrade them                                                  |

For a guest update, follow the [guest build and replacement guide](deploy/firecracker/README.md#development-guest-with-actual-tools-and-zendriver) and [node maintenance gate](deploy/firecracker/README.md#draining-a-node-before-release). Use fresh candidate directories, build the matching patched Zendriver before payload preparation, and retain the old verified image and an offline data-volume backup. Desktop candidates require the desktop build and acceptance checks. Run the privileged install through the maintenance wrapper, confirm VMM shutdown, preserve each assigned data disk and runtime metadata, and verify the new generation through the authenticated owner route. A built candidate is not installed until that image replacement succeeds. Failed acceptance remains a failed gate; inspect rollback and maintenance state before resuming.

### Recover browser ownership failures

`NOT_EXECUTED` with `effect: "unknown"` can mean the runtime rejected an abandoned active binding before dispatch. It can also represent other uncertain outcomes; trace the exact call and journal before drawing a conclusion. Do not repeat navigation or input automatically.

For an ordinary inactive browser, the Browser sidebar's **More controls → Restart browser**, then **Start browser**, can recover it. An active binding owned by a lost supervisor requires administrator recovery: confirm the old supervisor and its assigned guest browser processes are gone, using node drain and confirmed guest shutdown when needed. Invalidate only the matching session/owner/generation binding under the browser lock, preserve command/input journals, evidence and profiles, then resume and start one supervisor. Current automatic recovery and generic `reobserve` advice do not resolve that abandoned binding. Do not clear bindings, remove profile locks or delete disks merely because a service was restarted. See [the runtime recovery details](docs/runtime-implementation.md).

Full packaging instructions: [deployment guide](docs/deployment-guide.md#single-host-podman-deployment).

## Development terminals (alternative to Podman)

Use this workflow when developing the services outside Podman. Stop the corresponding deployed services first. This starts the web UI, API, background agent worker and audit consumer; managed browsing also needs the Browser Runtime below. You need Node.js **22.12+**, pnpm **11+**, PostgreSQL **16+**, Redis **7+**, and an API key for the provider selected by `MODEL`.

### 1. Install and configure

From the repository root:

```bash
pnpm install
```

Create `.env` from `.env.example` the first time only:

```bash
cp .env.example .env
```

If `.env` already exists, keep it and edit it instead of copying over it. Set `ANTHROPIC_API_KEY` for the default `MODEL=anthropic/claude-sonnet-4-20250514`, or set `MODEL` and the matching provider key. Keep keys in `.env`; never paste them into source files. The example file includes development values for `TOKEN_SECRET`, `ADMIN_PASSWORD`, and the local PostgreSQL URL. Change the admin password before first startup if you want a different login.

### 2. Start PostgreSQL and Redis

Start both services using your operating system's service manager. On Ubuntu/Debian, for example:

```bash
sudo systemctl start postgresql
sudo systemctl start redis-server
```

The example `.env` expects a PostgreSQL role/database named `trinity_harness`, with password `trinity_harness`. Create them once if they do not already exist (choose `trinity_harness` when prompted for the role password):

```bash
sudo -u postgres createuser --pwprompt trinity_harness
sudo -u postgres createdb --owner=trinity_harness trinity_harness
```

If you use different database credentials, update `DATABASE_URL` in `.env`. Check service readiness with `pg_isready` and `redis-cli ping` (`PONG` means Redis is ready).

### 3. Apply database migrations

```bash
pnpm db:migrate
```

### 4. Run the app in separate terminals

Run each command from the repository root and leave its terminal open:

| Terminal | Command           | What it starts                                  |
| -------- | ----------------- | ----------------------------------------------- |
| 1        | `pnpm dev:server` | API and SSE endpoint at `http://127.0.0.1:3000` |
| 2        | `pnpm dev:worker` | Background agent that handles prompts           |
| 3        | `pnpm dev:audit`  | Audit event consumer                            |
| 4        | `pnpm dev:web`    | Web UI at `http://localhost:5173`               |

```shell
pnpm dev:server
```

```shell
pnpm dev:worker
```

```shell
pnpm dev:audit
```

```shell
pnpm dev:web
```

The server, worker and audit consumer share `.env`. The first server startup creates the bootstrap admin when the users table is empty, using `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Open `http://localhost:5173` and sign in with those values. The agent runs tools inside `WORKSPACE_ROOT` (by default, the repository directory). Stop each process with **Ctrl+C**.

To start again later, ensure PostgreSQL and Redis are running, then start the four terminal commands above. You only need to install dependencies, create `.env`, create the database role/database, and apply migrations when setting up or upgrading the checkout.

**No responses from the agent?** Confirm the API is running with `curl http://127.0.0.1:3000/api/health` (it should return `{"ok":true}`), keep the worker terminal running, and check that `.env` has a valid key for the model named by `MODEL`. If sign-in fails, check `ADMIN_EMAIL` and `ADMIN_PASSWORD`; bootstrap credentials are used only when the database has no users yet.

## Firecracker guest execution (optional)

With the development-terminal workflow, the four commands above start the control plane and web app. Podman already starts the equivalent application services. With Firecracker enabled, components run in three places:

| Where                | Components                                        | What they do                                                                                    |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Control-plane host   | `server`, `agent-worker`, `audit-consumer`, `web` | The worker runs the agent loop and model calls. Tool execution is routed to the selected guest. |
| KVM host             | Node Agent and Firecracker/jailer systemd units   | The Node Agent starts and stops assigned VMs and relays authorized guest RPC.                   |
| Firecracker guest VM | `apps/guest-runtime` (`trinity-guest.service`)    | Runs workspace file and shell operations, skills, and—when configured—Zendriver/Chrome.         |

For **Zendriver** browsing in the development-terminal workflow only, start the Browser Runtime in a fifth terminal. Podman already manages this service:

```bash
pnpm dev:browser-runtime
```

The server, worker and Browser Runtime must share `EXECUTION_DRIVER=firecracker`, `BROWSER_DRIVER=zendriver`, the same `FIRECRACKER_NODES` inventory and `NODE_RUNTIME_TOKEN`, plus the Browser Runtime endpoint/token settings. The browser process handles private browser requests; with Firecracker selected, the browser itself runs inside the guest VM.

The **Node Agent runs on the KVM host** as a privileged systemd service, separate from the four or five development terminals. After one-time host installation and configuration, start or check it with:

```bash
pkexec /usr/bin/systemctl start trinity-node-agent.service
systemctl status trinity-node-agent.service
```

Its root-owned configuration is `/etc/trinity/node-agent.env`; it needs the control database URL, the matching `NODE_RUNTIME_TOKEN`, node ID, `/srv/trinity-node` state directory, and an explicit storage mode. Do not start the Node Agent inside the guest or load model/provider keys into it. The Node Agent service and host images, storage and networking must be provisioned before using guest execution. Follow the [Firecracker host and guest setup guide](deploy/firecracker/README.md) for those one-time steps and environment settings.

You do **not** start `apps/guest-runtime` with a separate host command. It is installed in the guest image and is launched by the VM's systemd unit when the control plane wakes an assigned environment. Each environment also needs its own provisioned data disk, runtime metadata and network namespace. Power state alone does not prove guest tools are ready. If this setup is missing any of those pieces, guest tool calls will fail even while the web app is running.

## Browser (live web access)

The `browser` tool always provides saved reads (`read_observation` / `search_observation`, available offline). Live operations require one of two modes, selected by `BROWSER_DRIVER`:

**Trusted CDP (optional; no extra service).** Live access stays off while `BROWSER_CDP_ENDPOINT` is unset. To enable it, attach to an operator-started Chrome: set `BROWSER_CDP_ENDPOINT=9222` (or a full URL) and optionally `BROWSER_CDP_OWNER_ID` to restrict browser use to one user. The worker talks to that Chrome directly through the pinned `agent-browser` CLI (0.38.x), so no browser process runs inside Trinity and no extra service is needed. Chrome must be started with remote debugging by the operator; Trinity never launches or replaces it.

**Managed Zendriver (separate supervisor process).** Set `BROWSER_DRIVER=zendriver`, `BROWSER_RUNTIME_ENDPOINT=http://127.0.0.1:3010`, and a shared `BROWSER_RUNTIME_TOKEN` (min 32 characters, same value in server, worker and runtime). With `EXECUTION_DRIVER=local`, set `BROWSER_PROFILE_DIR` to the protected persistent profile directory mounted into the Browser Runtime. With `EXECUTION_DRIVER=firecracker`, profile paths come from authenticated guest metadata on the persistent data volume; no host `BROWSER_PROFILE_DIR` mount is required. In the development-terminal workflow, run the supervisor next to `dev:server` / `dev:worker` (Podman already starts it):

```bash
pnpm dev:browser-runtime   # or `pnpm start:browser-runtime` (no watch)
```

An owner’s personal Main, side Chat and Work sessions share a browser anchored to Main, with serialized operations and per-call PostgreSQL command journaling. Local mode uses `<BROWSER_PROFILE_DIR>/<tenant-id>/<user-id>` with exclusive profile leases; Firecracker uses the assigned persistent guest profile. The configured desktop mode has its own guest browser service.

**Sandbox egress follows the host configuration.** Set `SANDBOX_PROXY_URL=http://127.0.0.1:20112` in the deployment `.env` to use an existing host HTTP proxy for the whole Firecracker guest, then apply the host egress installer through the maintenance release wrapper. Empty/unset uses direct host routing. This does not change the host default route or control-plane traffic. Proxy settings stay on the host; no Clash configuration or browser-specific guest route is needed. Locally launched managed Chrome also consumes this setting. The development network still blocks IPv6 and private/reserved destinations; see the [host guide](deploy/firecracker/README.md#whole-guest-egress-with-sandbox_proxy_url).

**Document capture and export.** Use the typed `browser` tool for live navigation and input. Extraction starts with `capture_document`; `export_capture` saves the rendered HTML/media bundle, and `export_markdown` saves the bundle first, then converts saved HTML offline with bundled Turndown/GFM. Downloaded media references point to local files where capture succeeded; unavailable resources and coverage gaps remain explicit. There is no separate capture enable flag or native converter to install. Capture requires the matching guest application and patched Zendriver build; a `DISABLED` build-mismatch error requires guest delivery, not another navigation attempt. See [browser capture design and limits](docs/browser-tool-design.md) and the [current acceptance status](docs/project-progress.md).

**Profile locks.** Graceful runtime shutdown releases resources it owns. Crash recovery reclaims only provably stale local profile locks; live, foreign or unverifiable owners fail closed. Firecracker profiles belong to the guest. Confirm ownership and process shutdown before any operator repair; profile-lock recovery and abandoned PostgreSQL browser-binding recovery are separate mechanisms.

## Configuration (`.env`)

| Variable                          | Required                   | Default                                                                       | Purpose                                                                                   |
| --------------------------------- | -------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | for PG store / migrations  | `postgresql://trinity_harness:trinity_harness@localhost:5432/trinity_harness` | PostgreSQL connection                                                                     |
| `REDIS_URL`                       | for distributed mode (M2)  | —                                                                             | Redis 7+ connection (streams, Pub/Sub, BullMQ)                                            |
| `TOKEN_SECRET`                    | when `DATABASE_URL` is set | —                                                                             | HMAC key for bearer tokens (min 16 chars)                                                 |
| `ADMIN_EMAIL`                     | no                         | `admin@trinity.local`                                                         | First-boot bootstrap admin email                                                          |
| `ADMIN_PASSWORD`                  | first boot only            | —                                                                             | First-boot bootstrap admin password (min 8 chars)                                         |
| `ANTHROPIC_API_KEY`               | for `anthropic/...` models | —                                                                             | Anthropic API key (server-side only)                                                      |
| `ANTHROPIC_BASE_URL`              | no                         | —                                                                             | Custom Anthropic-compatible endpoint                                                      |
| `OPENAI_API_KEY`                  | for `openai/...` models    | —                                                                             | OpenAI API key (server-side only)                                                         |
| `OPENAI_BASE_URL`                 | no                         | —                                                                             | Custom OpenAI-compatible endpoint                                                         |
| `MODEL`                           | no                         | `anthropic/claude-sonnet-4-20250514`                                          | Model in `provider/model-id` form                                                         |
| `REASONING_BUDGET_TOKENS`         | no                         | —                                                                             | Anthropic extended-thinking budget (tokens)                                               |
| `REASONING_EFFORT`                | no                         | —                                                                             | OpenAI reasoning effort (`low`/`medium`/`high`/…)                                         |
| `PORT` / `HOST`                   | no                         | `3000` / `127.0.0.1`                                                          | Server listen address                                                                     |
| `WORKSPACE_ROOT`                  | no                         | cwd                                                                           | Directory the agent sandbox is rooted at                                                  |
| `SYSTEM_PROMPT`                   | no                         | `You are Trinity…`                                                            | System prompt for the loop                                                                |
| `MAX_TURN_STEPS`                  | no                         | unlimited                                                                     | Optional per-agent step ceiling; reserves the last step for an answer                     |
| `TASK_MAX_TOOL_CALLS`             | no                         | unlimited                                                                     | Optional shared attempted tool-call ceiling; complete waves are admitted before execution |
| `TASK_MAX_REQUESTS`               | no                         | unlimited                                                                     | Optional shared request ceiling, including children, compaction and retries               |
| `TASK_MAX_TOKENS`                 | no                         | unlimited                                                                     | Optional shared input + output token ceiling                                              |
| `TASK_MAX_DURATION_MS`            | no                         | unlimited                                                                     | Optional task deadline in milliseconds                                                    |
| `TASK_MAX_COST`                   | no                         | unlimited                                                                     | Optional currency ceiling, e.g. `USD:1.50`; prices come from `config/models.yaml`         |
| `DEFAULT_PERMISSION_POLICY`       | no                         | `workspace-write`                                                             | M3: preset name or JSON policy for new sessions                                           |
| `ACP_SERVER_URL` / `ACP_TOKEN`    | for acp-gateway            | `http://127.0.0.1:3000` / —                                                   | M3: server HTTP binding + bearer for the gateway                                          |
| `CONTEXT_MAX_TOKENS`              | no                         | `160000`                                                                      | M4: projected-context budget before compaction                                            |
| `CONTEXT_KEEP_TOKENS`             | no                         | `40000`                                                                       | M4: retained recent-context floor when compacting                                         |
| `COMPACTION_MODEL`                | no                         | = `MODEL`                                                                     | M4: summarizer model                                                                      |
| `SPILL_THRESHOLD_BYTES`           | no                         | `50000`                                                                       | M4: tool results above this spill to the BlobStore                                        |
| `LSP_ENABLED` / `LSP_MAX_SERVERS` | no                         | `true` / `4`                                                                  | M4: language servers + per-process pool ceiling                                           |
| `SANDBOX_ENV_MODE`                | no                         | `minimal`                                                                     | M5: `minimal` scrubs secrets from tool children; `inherit` is local-only                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | no                         | —                                                                             | M5: OTLP/gRPC endpoint for traces + metrics                                               |
| `OTEL_PROMETHEUS_PORT`            | no                         | —                                                                             | M5: serve Prometheus `/metrics` on this port                                              |

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

For the rootless single-host stack, use `./scripts/deploy-podman.sh` to build and
deploy, then `./scripts/podman-services.sh start|stop|restart|status` for service
control without rebuilding. See the [Podman command guide](docs/deployment-guide.md#single-host-podman-deployment)
for prerequisites, configuration changes and host/VM lifecycle boundaries.

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
