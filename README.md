# Trinity Harness

Enterprise-grade, multi-user, browser ↔ server AI Agent platform — core scenario: software engineering agents (coding, debugging, refactoring, code review).

> Status: **M1** (minimal loop complete). Roadmap and architecture: [`docs/design.md`](docs/design.md). Progress: [`docs/project-progress.md`](docs/project-progress.md). Agent behavior rules: [`AGENTS.md`](AGENTS.md).

## What works today (M1)

- **Agent Loop** — turn/step driver with streaming LLM output, tool execution, abort handling, and an event-sourced session log (everything replayable).
- **LLM Gateway** — Vercel AI SDK based, model/provider/reasoning/API-URL all configurable via env.
- **Tools** — `read_file`, `write_file`, `edit_file` (exact-match str-replace), `glob`, `bash`, all routed through a `SandboxPort`.
- **Web UI** — React 19 + Ant Design 5 + Ant Design X chat; streaming bubbles and tool-call cards.
- **Persistence foundation** — Drizzle-managed PostgreSQL `session_events` (append-only, hash-chained, monotonic seq) with an in-memory store used by the M1 loop.

## Quick start

Prerequisites: **Node.js ≥ 22.12**, **pnpm 11+**, **PostgreSQL 16+** (local testing DB).

```bash
# 1. Install dependencies
pnpm install

# 2. Configure the environment
cp .env.example .env
#   - DATABASE_URL: defaults to the local trinity_harness test DB
#   - ANTHROPIC_API_KEY (or OPENAI_API_KEY when using "openai/..." models)

# 3. Apply database migrations (Drizzle Kit)
pnpm db:migrate

# 4. Run the backend (http://127.0.0.1:3000)
pnpm dev:server

# 5. In another terminal, run the web UI (http://localhost:5173)
pnpm dev:web
```

Open http://localhost:5173 and describe a coding task. The agent can read/write/edit files and run shell commands inside `WORKSPACE_ROOT` (defaults to the repo root).

## Configuration (`.env`)

| Variable                  | Required                   | Default                                                                       | Purpose                                           |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| `DATABASE_URL`            | for PG store / migrations  | `postgresql://trinity_harness:trinity_harness@localhost:5432/trinity_harness` | PostgreSQL connection                             |
| `ANTHROPIC_API_KEY`       | for `anthropic/...` models | —                                                                             | Anthropic API key (server-side only)              |
| `ANTHROPIC_BASE_URL`      | no                         | —                                                                             | Custom Anthropic-compatible endpoint              |
| `OPENAI_API_KEY`          | for `openai/...` models    | —                                                                             | OpenAI API key (server-side only)                 |
| `OPENAI_BASE_URL`         | no                         | —                                                                             | Custom OpenAI-compatible endpoint                 |
| `MODEL`                   | no                         | `anthropic/claude-sonnet-4-20250514`                                          | Model in `provider/model-id` form                 |
| `REASONING_BUDGET_TOKENS` | no                         | —                                                                             | Anthropic extended-thinking budget (tokens)       |
| `REASONING_EFFORT`        | no                         | —                                                                             | OpenAI reasoning effort (`low`/`medium`/`high`/…) |
| `PORT` / `HOST`           | no                         | `3000` / `127.0.0.1`                                                          | Server listen address                             |
| `WORKSPACE_ROOT`          | no                         | cwd                                                                           | Directory the agent sandbox is rooted at          |
| `SYSTEM_PROMPT`           | no                         | `You are Trinity…`                                                            | System prompt for the loop                        |

Secrets live server-side only: they are never sent to the frontend and never logged into event payloads.

## Scripts

| Command                                              | Purpose                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev:server` / `pnpm dev:web`                   | Dev servers (tsx watch / vite)                                       |
| `pnpm test`                                          | Vitest — unit + integration (DB tests auto-skip when unreachable)    |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Quality gates (all must pass)                                        |
| `pnpm db:generate` / `pnpm db:migrate`               | Drizzle Kit migration workflow (`generate` → review SQL → `migrate`) |

## Architecture (M1)

```
apps/web (React+antd) ──HTTP/SSE──> apps/server (Fastify) ──DI──> packages/core
                                       │                          ├─ AgentLoop
                                       │                          ├─ ToolRegistry + 5 tools
                                       │                          ├─ AiSdkGateway (Vercel AI SDK)
                                       │                          ├─ LocalSandbox
                                       │                          └─ MemorySessionStore
                                       └──────────── packages/db (PgSessionStore, Drizzle)
packages/contracts ← all ports (LLMPort, SandboxPort, ToolRegistry, SessionStore, AgentLoop)
```

Hard rules (see `AGENTS.md` §3): modules communicate **only** through `packages/contracts` interfaces; the object graph is assembled exclusively at app composition roots; tools never touch `child_process`/FS directly — only via `SandboxPort`; the event log is append-only.

## Roadmap

M0 monorepo + PG foundation ✅ · **M1 minimal loop ✅** · M2 PG event sourcing + Redis bus + auth · M3 ACP protocol + approvals · M4 LSP/compaction/subagents · M5 production hardening · M6 extensibility — details in `docs/design.md` §18.
