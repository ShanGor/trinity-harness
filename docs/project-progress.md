# Project Progress — Trinity Harness

> Companion to `docs/project-plan.md`. Update this file as work lands.
> Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` deferred

## Current milestone: M0 — Monorepo foundation

| Date       | Item                                                                     | Status | Notes                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-27 | Test DB config (`.env`: `trinity_harness@localhost:5432`)                | [x]    | `.env` created; added `.env` / `.env.*` to `.gitignore`                                                                                                              |
| 2026-09-27 | `docs/project-plan.md` + this file                                       | [x]    | —                                                                                                                                                                    |
| 2026-09-27 | Verify DB reachable & create role/database                               | [x]    | `pg_isready` OK; `psql -U trinity_harness -d trinity_harness -c 'select 1'` succeeds — role/db already exist                                                         |
| 2026-09-27 | Root bootstrap: package.json, pnpm workspace, tsconfig, ESLint, Prettier | [x]    | ESM `type: module`; both `pnpm-workspace.yaml` + `package.json#workspaces`; `linkWorkspacePackages: true` so pnpm resolves npm-compatible `*` internal deps          |
| 2026-09-27 | `packages/contracts` skeleton (ports + Zod events)                       | [x]    | `sessionEventSchema` (8 event types), `SessionStore` port, pure `projectMessages`, `EventBus` port                                                                   |
| 2026-09-27 | Env config module (Zod-validated, fail-closed)                           | [x]    | `packages/shared/src/env.ts` (`loadEnv`, throws on invalid/missing)                                                                                                  |
| 2026-09-27 | Drizzle + first migration (`session_events`, append-only)                | [x]    | `drizzle-kit generate` → `migrations/0000_*.sql` (PK `(session_id, seq)`); append-only trigger appended to migration; applied via `pnpm db:migrate`                  |
| 2026-09-27 | PG integration test vs `localhost:5432`                                  | [x]    | Suite auto-skips when DB unreachable; covers monotonic seq, concurrent appends, hash chain, boundary validation, `toSeq` truncation, projection, append-only trigger |
| 2026-09-27 | Dependency-direction lint gate                                           | [x]    | `import/no-restricted-paths` zones; verified it blocks `contracts → db` imports                                                                                      |
| 2026-09-27 | CI workflow (typecheck + lint + test)                                    | [x]    | `.github/workflows/ci.yml`: postgres:16 service, `pnpm db:migrate`, all gates + `npm install --dry-run` compat gate (design.md §3)                                   |

## Verification (2026-09-27)

- `pnpm typecheck` — pass (contracts / shared / db)
- `pnpm lint` — pass (gate verified with a scratch violation file)
- `pnpm test` — 15/15 pass
- `pnpm format:check` — pass
- `pnpm db:migrate` applied; `session_events` table + `session_events_append_only` trigger confirmed via psql `\d`

## M1 — Minimal loop (in progress → core complete)

| Date       | Item                                                                                                      | Status | Notes                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| 2026-09-27 | contracts 扩展：`LLMPort` / `SandboxPort` / `ToolDefinition` / `ToolRegistry` / `AgentLoop` / `LoopEvent` | [x]    | AI-SDK-agnostic chunk 抽象，测试可用 fake 驱动                                     |
| 2026-09-27 | shared：ACP 风格 wire schema（`session/update` 等）+ `loadEnv` 可选项                                     | [x]    | 对齐 design.md §11.4，M3 换 transport 不改消息形态                                 |
| 2026-09-27 | core：`AiSdkGateway`（ai v7，anthropic/openai 路由，工具无 execute 防止 SDK 代执行）                      | [x]    | 修复了 SDK 惰性 promise 的 unhandled rejection；缺 API key 时 fail-closed 干净报错 |
| 2026-09-27 | core：5 个内置工具（read/write/edit_file、glob、bash）经 SandboxPort                                      | [x]    | `LocalSandbox` 是唯一能 spawn 进程的类；edit_file 强制唯一匹配                     |
| 2026-09-27 | core：`CoreToolRegistry`（zod 校验 + 超时 + 错误收敛）                                                    | [x]    |                                                                                    |
| 2026-09-27 | core：`CoreAgentLoop`（turn 驱动、AbortSignal 贯穿、step 上限、事件落 SessionStore + EventSink）          | [x]    | M1 顺序执行工具；并发池 M2/M4                                                      |
| 2026-09-27 | core：`MemorySessionStore` + `toModelMessages` 纯函数折叠                                                 | [x]    | fakes 位于 `core/src/testing`（server 测试复用）                                   |
| 2026-09-27 | core 单测（22 个）：loop 驱动 / 工具语义 / 注册表 / 消息折叠                                              | [x]    | FakeLLM 脚本化流 + FakeSandbox，全确定性                                           |
| 2026-09-27 | apps/server：Fastify API + SSE 扇出，LoopEvent → ACP wire 翻译                                            | [x]    | 15s 心跳；zod 边界校验；composition root 在 main.ts                                |
| 2026-09-27 | packages/client-acp：POST + EventSource 封装（zod 校验入边界）                                            | [x]    | 重连原生；Last-Event-ID/缺口检测 M3                                                |
| 2026-09-27 | apps/web：React 19 + antd 5 + @ant-design/x Chat UI                                                       | [x]    | Bubble.List + Sender；vite proxy → server；`vite build` 通过                       |
| 2026-09-27 | server 集成测试：真实端口 + fetch 读 SSE 全流程                                                           | [x]    | create → SSE → prompt → tool_call → committed message                              |
| 2026-09-27 | 本地冒烟：server 启动、无 key 时 turn 干净失败、进程存活                                                  | [x]    | 真机 LLM 对话需 `ANTHROPIC_API_KEY`（未验证）                                      |
| 2026-09-27 | README.md；env 全量可配：provider key/base URL、`MODEL`、`REASONING_BUDGET_TOKENS`、`REASONING_EFFORT`    | [x]    | `loadServerEnv` 加载根 `.env`（dotenv quiet）；README 含配置表与 quick start       |

## Verification (2026-09-27, M1)

- `pnpm typecheck` — pass（contracts / shared / db / core / client-acp / server / web）
- `pnpm lint` — pass
- `pnpm test` — 40/40 pass（8 files）
- `pnpm format:check` — pass
- `apps/web` 生产构建通过

## Decisions log

| Date       | Decision                                                                                           | Rationale                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-27 | Local test DB = `trinity_harness` db/user/pass on `localhost:5432`; `.env` gitignored              | User request; secrets never committed (AGENTS.md §5)                                                                                 |
| 2026-09-27 | `pnpm-workspace.yaml` sets `linkWorkspacePackages: true`                                           | pnpm 11 no longer auto-links plain `*` internal deps; keeps package.json npm-compatible without `workspace:` protocol (design.md §3) |
| 2026-09-27 | Append-only enforced by PG trigger inside the drizzle migration                                    | Defense in depth on top of code-level discipline (AGENTS.md §4.3)                                                                    |
| 2026-09-27 | `seq` assigned via `pg_advisory_xact_lock(hashtext(session_id))` + `max(seq)+1` in one transaction | Simple monotonic `(session_id, seq)` guarantee across concurrent writers; no separate counter table                                  |
| 2026-09-27 | AI SDK tools declared **without** `execute`                                                        | The SDK must never run tools itself — execution stays in our registry so M3 approval hooks intercept every call (design.md §12)      |
| 2026-09-27 | Wire protocol = ACP-flavored `session/update` kinds over plain SSE (M1)                            | UI consumes ACP message shapes from day one (AGENTS.md §4.4); M3 only swaps transport framing                                        |
| 2026-09-27 | Tool/fake 复用：`core/src/testing` 子路径导出                                                      | server 集成测试需要 fake LLM/sandbox；避免跨包引用 test/ 目录                                                                        |

## Blockers

_None._
