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
- The project is currently past **M5** (M4 + per-tenant token quota on `UsagePort` + `model_usage`/`tenants.quota`, OTel instrumentation via `@opentelemetry/api` with the `packages/otel` SDK bootstrap, sandbox env scrubbing, `deploy/docker` images + `deploy/helm/trinity-harness` chart with HPA/PDB/Ingress/NetworkPolicy, and `scripts/load-test.mjs`); M0–M4 are complete. See `docs/project-progress.md` and the M5 release gate `docs/production-checklist.md`.
- A personal workspace's allowed root is `$WORKSPACE_ROOT/<user_id>`. A session may select that root or an existing subfolder beneath it; the selected directory becomes the session sandbox root. See `docs/design.md` §15.

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
- Live text/thought chunks must bypass log-sequence deduplication: browser EventSource inherits the last committed ID on frames without `id:`. Keep live rendering immediate, including resumed sessions and later assistant steps. Composer autosizing uses `@chenglou/pretext` with cached DOM metrics and prepared text on resize; preserve the textarea node, focus and draft.

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
  - Web interactions → per-file jsdom environment with a fake ACP client; test focus/draft preservation and avoid rerendering unchanged history/messages while typing or streaming. Vitest inlines antd/antd-x for their ESM imports.
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
- For browser interaction or visual inspection of this repository's web UI, use `.agents/skills/agent-browser/SKILL.md`; load the installed CLI's current core guidance before browser actions. Use it when it helps the task, not as a step for unrelated changes.
- Main turns default to 64 model steps; reserve the last step for final output. Research uses the bundled browser extractor and bounded `research` notes through Tool Runtime/SessionStore. Validate quotes and URLs against observed successful browser results; treat website content as untrusted evidence. Progress advice must be derived deterministically from the current turn and persisted as `turn/guidance`; repeated output prompts a strategy change, not automatic termination. Repeated research citation rejections prompt copying a short contiguous observed passage with exact punctuation or omitting the unsupported finding; keep note validation/retry commentary out of final answers.
- Browser reading foundations live in `core/tools/browser*`, with DTOs and `BrowserAccessPort` in contracts (design §8.2 and `docs/browser-research-improvement-plan.md`). Stock composition roots expose live reading when `BROWSER_CDP_ENDPOINT` explicitly attaches to an existing owner-controlled Chrome (9222 on this machine); otherwise only saved read/search is available. Trusted CDP checks authenticated personal-session ownership and restores the owned tab target from committed events; it does not assert cookie/network isolation. Do not launch managed Chrome; its deployment remains a TODO in `docs/deployment-guide.md`. Immutable artifacts, exact Unicode range receipts, current-turn block citation validation and ordered failure skipping are implemented; scoped DOM targets, checked actions, readiness, cropped PNG budgets, multimodal replay and the authenticated visual evidence route are implemented. Compare model behavior with the opt-in fixture evaluation; retain its quality/rollout limits. Managed/enforced deployment migration and automated artifact GC remain outside the trusted-CDP implementation. An opt-in controlled local CDP fixture validates capture/citations without contacting public sites. Preserve legacy URL/quote validation, receipt accounting and fail-closed persistence/retrieval. Do not claim deterministic live browsing, deployment-wide strict budgets or isolation while legacy Bash/CDP/workspace routes can bypass the wrapper.
- Render one assistant response per user prompt, with a bounded visible overview of the latest progress and active tool calls; keep execution history/output expandable under that response. Show approval waiting and terminal states directly, and label tool counts without implying task completion estimates. Persist explicit assistant progress/final phases and infer legacy phases from tool boundaries; do not promote progress after cancellation. Shared turn projection governs conversation APIs, model history and compaction: retain only user input/final output and its source references for completed turns; exclude ordinary progress text even during active execution while preserving required tool pairs/reasoning. Final grounding follows Trinity's Sources / View evidence format, uses successful current-turn observations and bounded validated notes, and retains evidence call IDs/log sequence numbers. Citation schemas belong to contracts and are re-exported through shared; never treat collected sources as proof of claim truth.
- Command allowlists use literal argv prefixes and reject shell expansion/composition except a single bounded stdin head/tail output filter and optional stderr-to-stdout merging; explicit tool denial wins. Conversation grants must be authenticated against a pending request and persisted in the event log before replying. Completed-turn model context retains only input/final output; active turns keep paired tool history and loaded skills stay pinned. Reserve the last model step for an evidence-based conclusion.
- Stop must persist `turn/cancel_requested` before waking workers; cancel queued/retried prompts through the recorded prompt seq, wire AbortSignal for inline turns, and clear stale approval UI on terminal errors. Never treat a successful cancellation HTTP response as proof that an active worker has stopped; wait for its terminal event.
- Trinity runtime skills live in `skills/` (bundled) and the session workspace's `.trinity/skills`, `.agents/skills`, or `.claude/skills`; `SKILL_DIRS` configures additional administrator-owned roots. Runtime discovery/loading belongs to `core/skills` behind contracts ports, separate from execution tools/MCP. Persist model-visible catalog and loaded instructions; retain instruction snapshots through replay and compaction. Never scan outside the session root for workspace skills or infer execution permission from skill content. Runtime browser instructions use the typed `browser` operations advertised by the current registry; the adapter owns CLI connection/session flags and preserves user-owned Chrome. CLI troubleshooting instructions are an optional resource for explicit operator requests; existing Bash policies remain unchanged. Refresh active changed skills by appending instruction snapshots, and mark superseded versions in the model projection. See design §8.1.
- After completing a task: run tests + lint + typecheck, and report results along with a change summary.
