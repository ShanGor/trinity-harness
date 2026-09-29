# AGENTS.md — Trinity Harness

> This file is the **highest behavioral authority** for coding agents (and human contributors) working in this repository.
> In case of conflict: user requirements > this file > existing implementations in the reference projects (dsh / oc).

---

## 1. Project Overview

An enterprise-grade, multi-user, browser ↔ server AI Agent platform (core scenario: software engineering Agent).

- **Design document**: `docs/design.md` (v0.1 draft) — **must read before writing code**; all architectural decisions defer to it.
- **Reference repositories**: `ref/deepseek-harness` (dsh), `ref/opencode` (oc).
  - ⚠️ `ref/` is gitignored and **read-only reference material. Do not import from it or copy large chunks of code into this repository as committed code** (mind their LICENSEs).
  - Follow the workflow in `docs/design.md` §20 to upgrade reference versions.
- The project is currently past **M3** (M2 + ACP HTTP binding `POST /acp`/`GET /acp/stream`, stdio `apps/acp-gateway` on the official `@agentclientprotocol/sdk`, permission presets, and the human approval flow with `approvals` table + `approval/*` log events); M0/M1/M2 are complete. See `docs/project-progress.md`.

---

## 2. Tech Stack & Toolchain

| Item            | Convention                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | TypeScript, Node.js 22+, **ESM only** (`"type": "module"`)                                                                                                        |
| Package manager | **pnpm primary, npm compatible**. pnpm-exclusive features are forbidden (`workspace:*`, `patchedDependencies`, `.pnpmfile.cjs`); rationale in `docs/design.md` §3 |
| AI abstraction  | Vercel AI SDK (`ai` + provider packages); never bypass it to call provider HTTP APIs directly                                                                     |
| Backend         | Fastify (HTTP + SSE), Zod for schema validation                                                                                                                   |
| Frontend        | React 19 + Ant Design 5 + Vite                                                                                                                                    |
| Database        | PostgreSQL 16+ (Drizzle ORM), Redis 7+ (Stream + Pub/Sub)                                                                                                         |
| Testing         | Vitest (unit); testcontainers or PG/Redis integration tests                                                                                                       |
| Lint / Format   | ESLint + Prettier — **must pass before committing**                                                                                                               |
| Monorepo        | pnpm/npm workspaces; directory structure per `docs/design.md` §3                                                                                                  |

---

## 3. Architectural Rules (violations = rejection)

1. **`packages/contracts` is the core of the entire design**: all inter-module communication goes exclusively through TypeScript interfaces (ports) defined there.
   - ❌ Modules importing each other's implementation packages (e.g., `modules/a` importing a concrete class from `modules/b`).
   - ✅ Depend on interfaces, inject via constructors; composition (assembly) exists only at each `apps/*` entry point.
2. **No `new XxxService()` inside business modules** — the object graph is assembled at the composition root.
3. **Event sourcing**: session state = a projection of the event log. Everything visible to the model must be replayable from the log. No shortcuts like "directly updating the messages table".
4. **Fail-Closed**: for security concerns (permissions, approvals, secrets), a missing component or timeout always results in denial — never degrade gracefully to "allowed".
5. **Stateless services**: `server` / `agent-worker` hold no local mutable state; state lives only in PostgreSQL / Redis / object storage.
6. **No Plugin concept**: do not introduce Cordis or any "plugin framework". Extension points = contracts interfaces + DI + MCP.
7. **PostgreSQL is the single source of truth**; Redis Stream / SSE are distribution layers that may be truncated and may lose data.

---

## 4. Coding Standards

### 4.1 TypeScript

- Enable `strict` in full; `any` is allowed only at external JSON boundaries (and must be immediately narrowed with Zod).
- **Define all cross-process/cross-module data structures with Zod schemas** and infer TS types from them (`z.infer`); do not hand-write duplicate interfaces. Shared frontend/backend schemas go in `packages/shared`.
- Use discriminated unions for event types, with `z.discriminatedUnion`.
- Public APIs must have explicit return type annotations; private functions may omit them.
- Error handling: use `Result` types or custom `Error`s with a `code` for recoverable errors; no empty `catch {}` blocks; no exceptions for normal flow control.

### 4.2 Async & Resources

- All concurrent code must support `AbortSignal` cancellation (LLM streams, tool execution, SSE connections).
- Async resources (streams, LSP subprocesses, Redis connections) must have a deterministic shutdown path — provide `dispose()` / `[Symbol.asyncDispose]`.
- No bare `setTimeout` polling; use events or `AbortSignal.timeout`.

### 4.3 SQL / Data Layer

- The `session_events` table is **append-only**: only `INSERT` and `SELECT` are allowed; no `UPDATE`/`DELETE` (enforced by a PG trigger in addition to migrations/retention jobs).
- All schema changes go through Drizzle Kit migration files (`packages/db/src/schema.ts` → `pnpm db:generate` → review SQL in `packages/db/migrations/` → `pnpm db:migrate`); never alter tables at runtime in code, never use `drizzle-kit push` outside local experimentation.
- Multi-row writes use transactions; `session_events` appends must guarantee monotonic `(session_id, seq)` via PG transactions + row locks (current impl: `pg_advisory_xact_lock` per session in `packages/db`).

### 4.4 Frontend

- Components consume ACP message types; antd components map 1:1 to ACP messages (see `docs/design.md` §11.5); do not invent a second private protocol.
- SSE client logic lives in `packages/client-acp` (reconnection, backoff, Last-Event-ID, gap detection); UI components must not each hand-roll their own EventSource.

---

## 5. Security Baseline

- Secrets (model API keys, etc.) are stored server-side only (K8s Secret + envelope encryption) — **never sent to the frontend, never written to logs or event payloads**.
- All user input (prompts, file names, tool arguments) is validated with size limits at the boundary.
- Tool execution must go through the Sandbox port; out-of-policy operations require approval. Worker processes must not spawn raw `child_process` (mock sandbox is fine in tests).
- Redact logs and events: no tokens, secrets, or full file contents.
- Outbound network (web_fetch/web_search) goes through an egress allowlist, off by default.

---

## 6. Testing Requirements

- **New/modified logic must come with tests**. Layers:
  - Pure functions (projections, reducers, renders) → unit tests, mandatory.
  - Port implementations → integration tests with in-memory fakes or testcontainers.
  - Loop → drive event sequences with fake `LLMPort` / fake `ToolRegistry`, assert the log event stream.
- Tests must be deterministic: no reliance on real network, real LLMs, or real clocks (inject a clock).
- Event-sourcing code must test the "crash recovery replay" path (torn-tail repair).
- Commands: `pnpm test`, `pnpm lint`, `pnpm typecheck` — all three must pass for work to be considered done.

---

## 7. Git & Commit Conventions

- Do not proactively run `git commit/push/rebase` or other mutating git operations unless the user explicitly asks.
- Follow the existing repo history for commit message style; new commits use English, imperative mood (e.g., `Add session event projection`).
- One commit does one thing; separate formatting/lint fixes from logic changes.
- Never commit secrets, large files other than lockfiles, or build artifacts (dist/, node_modules/).

---

## 8. Documentation Sync Obligations

- When you change architecture, module boundaries, directory structure, tech choices, or build/test workflows, you **must update** `docs/design.md` and this file accordingly.
- When adding a module: first register it in the module table in `docs/design.md` §5, then define its port in `packages/contracts`, then implement.
- The "why" of design decisions belongs in `docs/design.md`; code comments should only say "what / gotchas", not repeat documentation.

---

## 9. Agent Behavioral Guidelines

- **Read `docs/design.md` before acting**; don't guess at design you don't understand — ask the user.
- Make the minimal change that achieves the goal; no abstractions for "maybe someday" (YAGNI), except the architectural rules in §3.
- Follow existing code style; new files follow §4 of this document.
- When in doubt, borrow the **ideas** from dsh/oc rather than their code details; when they conflict with each other, this design document wins.
- After completing a task: run tests + lint + typecheck, and report results along with a change summary.
