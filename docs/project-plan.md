# Project Plan — Trinity Harness

> Scope: getting from empty repo (M0) to a working monorepo foundation backed by the local test database.
> Design authority: `docs/design.md`. Behavior authority: `AGENTS.md`.

## 0. Test Environment

| Item                       | Value                                                                         |
| -------------------------- | ----------------------------------------------------------------------------- |
| PostgreSQL                 | `localhost:5432`                                                              |
| Database / User / Password | `trinity_harness` / `trinity_harness` / `trinity_harness`                     |
| Config source              | `.env` (gitignored, local dev & integration tests only)                       |
| `DATABASE_URL`             | `postgresql://trinity_harness:trinity_harness@localhost:5432/trinity_harness` |

- Create the role/database once locally: `createuser trinity_harness && createdb -O trinity_harness trinity_harness`.
- Env loading: apps read `.env` via a small config module (never commit `.env`; CI supplies its own).

## 1. M0 Milestone Goals (from design.md §18)

Monorepo + `packages/contracts` + DI assembly + PostgreSQL/Redis base + CI, with the contracts package compiling and a dependency-direction lint gate in place.

## 2. Planned Changes (ordered)

1. **Repo bootstrap**
   - `package.json` (root, ESM, `"type": "module"`), pnpm workspace config, TypeScript base config, ESLint + Prettier.
   - Scripts: `pnpm test`, `pnpm lint`, `pnpm typecheck` (must all pass per AGENTS.md §6).

2. **Monorepo skeleton** (directory structure per design.md §3)
   - `packages/contracts` — core ports/interfaces, Zod schemas, discriminated-union event types.
   - `packages/shared` — cross-frontend/backend Zod schemas.
   - Reserve `apps/server`, `apps/agent-worker`, `apps/web` (empty stubs until needed; YAGNI).

3. **Configuration module**
   - Zod-validated env parsing (reads `DATABASE_URL` etc. from `.env` in dev).
   - Fail-closed defaults: missing required env (e.g., `DATABASE_URL`) = startup error.

4. **PostgreSQL base**
   - Drizzle ORM + migration setup pointed at the test DB.
   - First migration: `session_events` append-only table (`session_id`, `seq`, monotonic sequence guarantee per AGENTS.md §4.3) plus minimal projections table(s) as required by design.md.
   - Integration test against `localhost:5432` (skipped if DB unreachable; testcontainers later per design.md).

5. **Dependency-direction gate**
   - ESLint `import/no-restricted-paths` (or equivalent) enforcing: modules depend only on `packages/contracts` interfaces, never on each other's implementations (AGENTS.md §3.1).

6. **CI**
   - GitHub Actions: install → `pnpm typecheck` → `pnpm lint` → `pnpm test`.

7. **Docs sync**
   - Update `docs/design.md` §3 structure / module table §5 if the skeleton deviates.
   - Track progress in `docs/project-progress.md`.

## 3. M1 Milestone Goals (design.md §18)

最小闭环：Loop + LLM Gateway（AI SDK）+ 4 个文件工具 + bash + 内存版会话 + 简化 Web UI（antd Chat）。验收：浏览器完成一次多轮编码对话。

Planned changes (ordered):

1. **contracts 扩展**：`LLMPort`（流式 chunk 抽象，与 AI SDK 解耦，测试用 fake）、`SandboxPort`、`ToolDefinition`/`ToolRegistry`、`AgentLoop` 端口 + `LoopEvent` 事件类型。
2. **shared 扩展**：ACP 风格 wire schema（`session/update` 的 `agent_message_chunk` / `tool_call` 等，前后端共享，对齐 design.md §11.4；M3 换成官方 ACP transport 时消息形态不变）。
3. **packages/core**（实现包，只依赖 contracts/shared）：
   - `llm/ai-sdk-gateway.ts` — Vercel AI SDK `streamText` 适配（anthropic/openai provider，按 `provider/model` 路由）。
   - `tools/` — read_file / write_file / edit_file(str-replace) / glob / bash，全部经 `SandboxPort`；`LocalSandbox`（本地开发，child_process 仅限此类内）+ 测试用 `FakeSandbox`。
   - `tool-registry.ts` — zod 参数校验 + 错误收敛为 `isError` 结果。
   - `loop/agent-loop.ts` — turn 驱动：投影消息 → 流式调用 → 工具执行 → 事件落 `SessionStore` 并经 `EventSink` 实时发出；`toModelMessages` 纯函数折叠事件日志为模型消息。
   - `session/memory-session-store.ts` — 内存版会话（design M1 明确内存版；PG 版已在 packages/db）。
4. **apps/server**（Fastify，composition root）：`POST /api/sessions`、`POST /api/sessions/:id/messages`、`GET /api/sessions/:id/messages`、`GET /api/sessions/:id/events`（SSE）。Loop 事件 → ACP 风格事件翻译后扇出。
5. **packages/client-acp**：POST + EventSource 封装（自动重连；Last-Event-ID/缺口检测属 M3）。
6. **apps/web**（React 19 + antd 5 + @ant-design/x）：Bubble 消息流 + Sender 输入 + 工具调用折叠展示；vite dev proxy → server。
7. **测试**：loop 驱动测试（fake LLM 脚本化流、fake sandbox）、工具语义测试、消息折叠纯函数测试、server API 测试（真实端口 + fetch 读 SSE）。
8. **Docs sync**：AGENTS.md（阶段状态）、project-progress.md。

## 4. Out of Scope

- M0 items: all done (see project-progress.md).
- M1 不做：审批流、ACP 官方 HTTP binding、SSE 断点续传（M3）、Redis Stream（M2）、compaction/LSP（M4）。
- 工具并发池：M1 顺序执行，并发池随 M2/M4。

## 5. Risks / Open Questions

- Redis availability: design assumes Redis 7+; defer until M2, use in-memory fakes for now.
- `ai` SDK v7 API surface (streamText/fullStream) — verify against installed version during implementation; gateway is the only AI SDK touchpoint, so churn is contained.
