# Trinity Harness —— 企业级 Browser-Server AI Agent 架构设计

> 版本：v0.1（草案）
> 日期：2026-09-27
> 状态：待评审

---

## 1. 项目愿景

构建一个**企业级、多用户、浏览器 ↔ 服务器架构**的 AI Agent 平台，核心场景为软件工程 Agent（编码、调试、重构、代码审查），并具备向通用企业 Agent 场景扩展的能力。

**关键目标：**

1. **多租户/多用户**：服务端集中部署，多用户并发使用，会话相互隔离。
2. **模块化架构**：模块之间只通过**显式定义的接口**通信，杜绝"插件（Plugin）"这种边界模糊的概念。任何模块可独立重构、替换、升级，对其他模块影响最小。
3. **协议开放**：前后端之间支持 **ACP（Agent Client Protocol）**，同时提供 Web 原生协议；未来可被 Zed、JetBrains 等编辑器直接接入。
4. **企业级能力**：审计、权限、审批、配额、可观测性是一等公民。
5. **云原生**：目标部署到 Kubernetes，水平扩展、滚动升级、故障自愈。

**设计参考：** deepseek-harness（`ref/deepseek-harness`，下称 **dsh**）、opencode（`ref/opencode`，下称 **oc**）。

---

## 2. 设计原则

| #   | 原则                           | 说明                                                                                                             |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| P1  | **接口即契约**                 | 每个模块对外只暴露 TypeScript interface（端口），依赖注入（DI）组装实现。禁止模块间直接 import 具体实现。        |
| P2  | **事件溯源的会话日志**         | 会话状态 = 事件日志的投影（借鉴 dsh）。模型可见的一切必须可从日志重放，审计因此免费获得。                        |
| P3  | **拦截点外置**                 | Agent Loop 保持精简；权限、审计、限流、脱敏都以"管线拦截器/装饰器"挂在 Loop 外（借鉴 dsh 的 waterfall 拦截点）。 |
| P4  | **工具的值/渲染分离**          | 工具执行返回规范化 JSON 值，渲染成模型可读内容由独立层负责（借鉴 dsh）。                                         |
| P5  | **无状态服务，有状态归数据层** | 计算服务（API、Agent Worker）无本地状态，状态全部落 PostgreSQL / Redis，K8s 上可自由伸缩。                       |
| P6  | **全局事件总线**               | Redis Stream 作为唯一的事件分发机制，任何模块通过订阅流获得实时事件，支持多实例扇出。                            |
| P7  | **失败关闭（Fail-Closed）**    | 权限、审批、密钥等安全环节，组件缺失或超时一律拒绝。                                                             |

> 关于"不要 Plugin"：dsh 用 Cordis 插件框架同时承担了三种职责——DI 装配、部署组合、第三方扩展——这是我们**明确要避免**的。本设计中这三者分离：
>
> - **模块装配** = DI 容器 + 显式接口（编译期类型安全）；
> - **部署组合** = 配置文件声明启用哪些模块（等价于 dsh 的 profile/bundle，但只是配置，不是代码扩展机制）；
> - **第三方扩展** = 仅保留一个**狭义的、沙箱化的**外部工具接入通道（MCP），不开放服务端代码级扩展。

---

## 3. 技术栈

| 层              | 选型                                        | 理由                                                                                                 |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 语言            | TypeScript（Node.js 22+，ESM）              | 全栈同构；AI SDK 生态最成熟                                                                          |
| AI 抽象         | **Vercel AI SDK**（`ai` + provider 包）     | 统一 `generateText/streamText` 接口，天然支持工具调用、多模态、流式                                  |
| 前端            | **React 19** + **Ant Design 5**             | antd 提供企业级组件（表格、审批流、表单），省去大量开发                                              |
| 前端构建        | Vite                                        |                                                                                                      |
| 后端框架        | Fastify（HTTP + SSE）                       | 轻量、高性能、schema-first                                                                           |
| 数据库          | **PostgreSQL 16+**                          | 会话事件、用户、审计、配额（pgvector 预留）                                                          |
| 缓存/事件       | **Redis 7+**（Stream + Pub/Sub + 分布式锁） | Stream 做事件总线，Pub/Sub 做低延迟信号                                                              |
| 任务队列        | BullMQ（基于 Redis）                        | Agent 任务异步调度、重试                                                                             |
| ORM             | Drizzle（**Drizzle Kit 管理迁移**）         | 类型安全、轻量；`drizzle-kit generate` 生成 SQL 迁移文件、`drizzle-kit migrate` 应用，禁止运行时改表 |
| RPC/事件 Schema | Zod（单 schema 库，前后端共享）             | 与 AI SDK、Fastify 天然配合                                                                          |
| K8s             | 原生 manifests（或 Helm）                   |                                                                                                      |
| 可观测性        | OpenTelemetry + Prometheus                  |                                                                                                      |
| LSP             | `vscode-languageserver-protocol` 客户端库   |                                                                                                      |
| 包管理器        | **pnpm（主）**，同时兼容 **npm**            | 见下方说明                                                                                           |

**包管理器约定（pnpm 为主、npm 兼容）：**

- workspaces 配置同时提供 `pnpm-workspace.yaml` 和 `package.json#workspaces`（npm 只认后者，字段保持子集兼容）。
- **禁止**使用 pnpm 独占特性：`workspace:*` 等专用协议、`patchedDependencies`（需 patch 时优先升级依赖或 fork）、`.pnpmfile.cjs`。
- 内部包之间的版本引用使用 `*` 或统一固定版本号，保证 npm 安装可解析。
- CI 中跑 `npm install --dry-run` 兼容性 gate，保证两条安装路径都可用。
- lockfile：主 lockfile 为 `pnpm-lock.yaml`；`package-lock.json` 不强制提交，但发布物（Docker 镜像）以 pnpm 锁定构建。

Monorepo 采用 pnpm/npm workspaces，分层目录：

```
trinity-harness/
├── apps/
│   ├── web/                    # React 19 + antd 前端
│   ├── server/                 # API 服务（Fastify，无状态；M2 起 enqueue-only + SSE relay）
│   ├── agent-worker/           # Agent 执行进程（Loop 所在；消费 BullMQ turn 队列）
│   ├── audit-consumer/         # 审计消费者（M2：audit stream → audit_log，见 §13）
│   └── acp-gateway/            # ACP 协议网关（stdio ↔ /acp HTTP binding，M3，官方 SDK）
├── packages/
│   ├── contracts/              # ★ 全局接口契约（所有模块边界的唯一定义处）
│   ├── core/                   # 模块实现：loop、tools、session、llm、auth（token/password）…
│   ├── redis/                  # Redis 适配层（EventBus/Stream/PubSub/BullMQ，M2）
│   ├── otel/                   # OTel SDK 引导层（OTLP/Prometheus 导出，M5）
│   ├── shared/                 # 工具函数、zod schema、事件类型
│   └── db/                     # PostgreSQL 适配层（Drizzle schema/migrations、SessionStore/Identity/Audit 实现）
├── deploy/
│   ├── docker/                 # 各组件 Dockerfile + web nginx 配置（M5）
│   └── helm/trinity-harness/   # Helm chart：HPA/PDB/Ingress/NetworkPolicy（M5）
├── scripts/
│   └── load-test.mjs           # 性能压测脚本（M5，§18 验收）
└── docs/                       # 设计文档
```

> M2 实现注记：§13 审计采用"独立 `audit` stream + `audit_log` 表 + 独立 consumer"路径（`apps/audit-consumer`），登录等无会话上下文的操作由此覆盖；`session_events` 内嵌 `audit/*` 事件类型未采用。
>
> M3 实现注记：§12 审批采用"Loop 内策略门（`PolicyToolRegistry` 装饰器）+ Redis Pub/Sub 审批通道（`sessappr:*`）+ `approvals` 表 + 事件日志 `approval/requested`/`approval/resolved`"组合；`session_events` 的 append-only 触发器为"被策略拒绝且从未运行的 user prompt"开了一个受控例外（仅允许删除会话尾部的 `message/user` 行，迁移 0003）。审批通道 fail-closed：无应答器/超时/取消一律拒绝。`acp-gateway` 使用官方 `@agentclientprotocol/sdk`（包名无连字符）走 stdio NDJSON，翻译到 server 的 `/acp` HTTP binding；`session/prompt` 由 server 持有至 turn 结束（ACP 语义），`session/request_permission` 经 `/acp/stream` 下发、经 REST respond 端点回传。
>
> M5 实现注记：§17 配额采用"`model_usage` 表（迁移 0004）+ `tenants.quota` jsonb + `UsagePort`/`QuotaAdminPort`（contracts）+ Loop 内 `beforeModelCall` 门（超窗/读失败均 fail-closed 拒绝，friendly error 经 `turn/end` detail 返回）"；usage chunk 按模型请求聚合成单条记录，best-effort 落库。窗口为日历窗（时/日/月 UTC）。§17 可观测性：core 只用 `@opentelemetry/api` 全局 tracer/meter（无 SDK 时为 no-op），`packages/otel` 在各 app composition root 按 `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_PROMETHEUS_PORT` 注册 NodeSDK；埋点 = turn/step/tool/approval 四个 span + token/工具成功率/审批延迟/turn 耗时/队列深度（worker 侧 ObservableGauge 直读 BullMQ counts）指标。§12.3 Sandbox 加固：`LocalSandbox` 默认 env 净化（minimal：只传 PATH/HOME/LANG/TZ/TMPDIR 等运维变量，`SANDBOX_ENV_MODE=inherit` 仅为本地兼容保留）；gVisor 以 K8s `runtimeClassName` 预留（`agentWorker.runtimeClassName`），Firecracker 预留同一端口。§16 部署：`deploy/docker/*.Dockerfile` + `deploy/helm/trinity-harness`（server HPA 2–20 + PDB、worker HPA 1–50、audit-consumer 2、acp-gateway 默认关、Ingress 关 SSE 缓冲、NetworkPolicy 默认拒绝出口 + allowlist 外发关断）；worker 队列深度 0→N 伸缩需 KEDA（HPA v2 不支持队列指标，见 docs/production-checklist.md）。server/worker/audit-consumer 均有 SIGTERM drain（BullMQ close 等待在途 turn）。

**`packages/contracts` 是全设计的核心**：所有模块接口（端口）、事件类型、DTO schema 集中定义，模块之间只允许依赖它。

---

## 4. 总体架构

```
                        ┌──────────────────────────────────────────────┐
                        │                   K8s Cluster                 │
                        │                                              │
 Browser (React+antd)   │   ┌───────────┐   ┌───────────────────────┐  │
        ▲  │            │   │  Ingress  │──▶│  server (API, ×N)     │  │
        │  │ SSE (GET)   │   └───────────┘   │  - /acp (POST+SSE)    │  │
        │  └────────────│───────────▶       │  - REST 控制面         │  │
        └───────────────│───────────────────│  - 鉴权/租户路由       │  │
                        │                   └───┬───────────┬───────┘  │
 Zed / 编辑器 (ACP stdio)│                       │           │          │
        └───────────────│────────▶ ┌────────────┴──┐   ┌────┴───────┐  │
                        │          │ acp-gateway   │   │  Redis     │  │
                        │          │ (stdio↔内部API)│   │  - Streams │  │
                        │          └───────────────┘   │  - Pub/Sub │  │
                        │                              │  - Locks   │  │
                        │   ┌──────────────────────────┴───────┐    │  │
                        │   │  agent-worker (×N, 无状态)        │    │  │
                        │   │  ┌──────┐ ┌──────┐ ┌───────────┐ │    │  │
                        │   │  │Loop×M│ │工具链 │ │LSP Client │ │    │  │
                        │   │  └──────┘ └──────┘ └───────────┘ │    │  │
                        │   └──────────┬───────────────────────┘    │  │
                        │              │ 事件 append                 │  │
                        │   ┌──────────┴───────────┐  ┌──────────┐  │  │
                        │   │ PostgreSQL            │  │ 审计消费者 │  │  │
                        │   │ - session_events      │  │ (独立Pod) │  │  │
                        │   │ - users/tenants/quota │  └──────────┘  │  │
                        │   │ - audit_log           │                │  │
                        │   └───────────────────────┘                │  │
                        └──────────────────────────────────────────────┘
```

**请求路径（一次对话）：**

1. 浏览器通过 Ingress 建立 SSE 连接（`GET /acp/stream`）→ `server` 鉴权、路由。
2. 用户发送 prompt → `POST /acp`（JSON-RPC `session/prompt`）→ `server` 写 `session_events`（user_message）→ 向 BullMQ 投递任务。
3. `agent-worker` 领取任务，从 PG 加载会话事件日志，重放投影出消息上下文。
4. Loop 运行（LLM 流式调用 + 工具执行），每产生一个事件立即 append 到 PG 并发布到 Redis Stream。
5. `server` 订阅对应流，将事件翻译为 ACP `session/update` 经 SSE 实时推送给浏览器；其他订阅者（审计、配额、ACP stdio 客户端）并行消费。

---

## 5. 模块划分与接口（核心章节）

### 5.1 模块总览

| 模块                    | 职责                                                                                    | 关键依赖（仅 contracts）                                        |
| ----------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `LLM Gateway`           | 统一模型访问：流式、工具调用、多模态、重试、计量                                        | `ModelProvider`                                                 |
| `Agent Loop`            | turn/step 驱动、工具调度、并发控制、取消                                                | `ToolRegistry`、`SessionStore`、`LLMPort`、`ApprovalPort`       |
| `Tool Runtime`          | 工具注册、参数校验、执行管线（pre/execute/post）；有界 browser reading；上线边界见 §8.2 | `SandboxPort`、`BrowserAccessPort`、`BlobStore`、`SessionStore` |
| `Session Core`          | 事件溯源日志、消息投影、压缩（compaction）、fork                                        | `EventBus`                                                      |
| `Context Manager`       | 上下文压力检测、压缩、溢出文件化（spill）                                               | `LLMPort`、`SessionStore`                                       |
| `Skill Runtime`         | SKILL.md 发现、渐进加载、显式调用、资源读取与指令快照回放（core/skills）                | `SkillCatalogPort`、`SkillRuntimePort`、`SessionStore`          |
| `LSP Service`           | 语言服务接入：诊断、符号、跳转、格式化                                                  | （对 Loop 暴露为工具）                                          |
| `Permission & Approval` | 工具审批、策略判定、审批持久化                                                          | `EventBus`                                                      |
| `Audit`                 | 全链路审计事件采集与查询                                                                | `EventBus`                                                      |
| `Multimodal`            | 图片/文档解析、附件存储、内容分块                                                       | `BlobStore`                                                     |
| `Sandbox`               | 命令执行与文件系统隔离（先容器内，预留 gVisor/Firecracker）                             | —                                                               |
| `Observability`         | OTel 埋点（api 全局）+ SDK 引导（OTLP/Prometheus 导出）                                 | `@opentelemetry/api`                                            |
| `Identity & Tenant`     | 用户、租户、RBAC、配额                                                                  | PostgreSQL                                                      |
| `Event Bus`             | Redis Stream 封装：发布、消费组、重放                                                   | Redis                                                           |
| `API Server`            | REST/SSE 网关、`/acp` HTTP binding、会话控制、配置                                      | 以上全部（通过 DI）                                             |
| `ACP Adapter`           | ACP 协议 ↔ 内部服务的翻译层                                                             | `API Server`（内部 SDK）                                        |

### 5.2 接口定义示例（`packages/contracts`）

所有端口为纯 TypeScript interface，zod schema 描述 DTO。**模块间禁止互相 import 实现包**。

```ts
// contracts/src/llm.ts —— LLM 端口（基于 Vercel AI SDK 抽象）
export interface LLMPort {
  stream(req: ModelRequest): Promise<ModelStream>;   // 含 tools、多模态 content
  countTokens(req: ModelRequest): Promise<number>;
}
export interface ModelRequest {
  model: string;                       // 如 "anthropic/claude-sonnet-4" 或 "ds/deepseek-chat"
  messages: Message[];                 // AI SDK 标准消息（支持 image/file parts）
  tools?: ToolSchema[];                // JSON Schema
  signal?: AbortSignal;
}

// contracts/src/tools.ts —— 工具定义（值/渲染分离，借鉴 dsh）
export interface ToolDefinition<A = unknown, V = unknown> {
  name: string;
  description: string;
  parameters: ZodSchema<A>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult<V>>;  // 返回规范化 JSON 值
  render?(args: A, value: V): ContentBlock[];  // 值 → 模型可见内容（可覆盖）
  concurrency?: 'parallel' | 'exclusive';
  timeoutMs?: number;
}
export interface ToolRegistry {
  register(def: ToolDefinition): Disposable;
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>; // 内建 pre/post 管线
}

// contracts/src/session.ts —— 事件溯源会话
export type SessionEvent =        // 判别联合，zod 校验，append-only
  | { type: 'session/created'; ... }
  | { type: 'message/user'; surfaceOp: 'append'; content: ContentBlock[] }
  | { type: 'message/assistant'; surfaceOp: 'append'|'replace'; ... }
  | { type: 'tool/call'; callId: string; name: string; args: unknown }
  | { type: 'tool/result'; callId: string; value: unknown; isError: boolean }
  | { type: 'compaction/summary'; ... }        // 日志事件，不变更表面
  | { type: 'audit/*'; ... };                   // 所有敏感操作
export interface SessionStore {
  append(sessionId: string, events: SessionEvent[]): Promise<SeqRange>; // fsync 语义
  load(sessionId: string, opts?: { toSeq?: number }): Promise<SessionEvent[]>;
  projectMessages(sessionId: string): Promise<Message[]>;  // 增量投影（含 surfaceOp replace）
}

// contracts/src/events.ts —— 全局事件总线（Redis Stream 之上）
export interface EventBus {
  publish(stream: string, event: BusEvent): Promise<void>;
  subscribe(stream: string, group: string, handler: (e: BusEvent) => Promise<void>): Disposable;
}

// contracts/src/approval.ts —— 审批端口（fail-closed）
export interface ApprovalPort {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>; // allowed|rejected|cancelled，无应答器=拒绝
}

// contracts/src/lsp.ts
export interface LSPPort {
  ensureWorkspace(root: string, langs: LangId[]): Promise<void>;  // 惰性启动语言服务
  diagnostics(file: string): Promise<Diagnostic[]>;
  symbols(query: string): Promise<SymbolInfo[]>;
  hover(file: string, pos: Position): Promise<string | null>;
  shutdown(root: string): Promise<void>;
}
export type LangId = 'python' | 'typescript' | 'json' | 'yaml' | 'java' | 'rust';
```

### 5.3 依赖方向规则

```
contracts（谁都不依赖）
   ▲
   │ 仅依赖接口
   │
modules/*  ──❌──  modules/*     （模块间不得直接依赖实现）
   ▲
   │ DI 装配（apps/* 的 composition root）
apps/server、apps/agent-worker、apps/web
```

模块间需要协作时，一律通过 contracts 中的端口 + 构造注入。装配代码（composition root）集中放在各 app 入口，**业务模块内不允许出现 `new XxxService()`**。

---

## 6. Agent Loop 设计（借鉴 dsh）

### 6.1 Turn / Step 语义

- **Step** = 一次模型请求 + 其全部工具调用；**Turn** = 完成一轮用户输入所需的 1..N 个 Step。
- 事件序列（全部落事件日志）：

```
turn/start
  step/start → request/header → message/assistant(流式 settle) → tool/call → tool/result × N
  step/end
  （上下文压力/溢出 → 触发 compaction）
turn/end (completed | max-tokens | blocked | aborted | error)
```

- 默认 turn budget 为 **64 model steps**（server/worker 的 `MAX_TURN_STEPS` 可配置 1..1024）（显式子 agent budget 仍独立，默认 worker child 为 16）；最后一步禁用工具用于最终回答。工具运行次数和 model step 分别计量，不把审批等待当成 model step。
- **研究执行**：默认 live 使用 Skill Runtime + Bash/Sandbox；typed browser 只读 adapter 和 saved evidence 路径见 §8.2，live capability 按部署边界 fail-closed。bundled skill 的 DOM extractor 一次提取有界正文、URL、标题、明确 publication metadata 和正文链接；无 metadata 时日期为 null，不从侧栏猜测。`research` tool 位于既有 Tool Runtime，composition root 注入 SessionStore/BlobStore，contracts 定义 Zod DTO。它记录问题范围、claims、支持/反证/背景引用、未决问题与是否足够作答；引用必须来自当前 prompt 后成功的 agent-browser tool/result，URL 和 quote 同时匹配结构化提取结果。校验保证观察来源，不保证网站真实或 claim 语义正确；页面始终是未信任数据。引文不匹配时返回具体 finding/source 位置及最多 600 字符的原文片段；仅为定位诊断按稳定文字片段寻找附近正文，接受条件仍为 URL 与逐字引文匹配（只忽略空白差异），不自动修正或认可 claim。notes 通过普通 tool/call/result append-only 留痕，重启可 replay；spill 后按当前 session/call 的受限 blob URI 恢复（最多 500 KB），不跨 session 读取；不建立内存账本或新表，不额外联网。完成 turn 后 notes 随内部工具历史退出后续 context，最终回答须自带关键结论/引用。
- **进度反馈**：Loop 内纯函数从当前 prompt 的 tool events 检测三次连续浏览器失败/空 read，以及当前页面上三次重复 read（忽略变动的 accessibility refs）。重复输出只能说明观察没有变化，不等价于任务停滞；只提示换读取方式/来源或总结，不自动停止或重复副作用。在多个来源已提取但未记录 notes 时要求 evidence checkpoint，notes 后每新增两个来源要求更新结论/未决问题，notes 标记 ready 时提示回答；两次 research 引文校验失败后提示直接复制短的连续原文或移除不支持的 finding，成功记录 notes 后清除；该提示不强制停止，最终回答不应包含内部记账/重试说明。到 budget 最后四分之一提示收敛；guidance 变化追加 `turn/guidance`，模型只见当前 prompt 的最新 guidance，进展恢复时清除旧提示。compaction 不压缩活动 turn；历史 UI 不把 guidance 当作普通回复。
- Turn 的最后一个允许 step 预留为无工具的最终回答：基于已有证据总结，并明确未完成工作/证据缺口；防止耗尽全部 step 后只有进度消息。模型仍请求工具时不执行超预算副作用。

### 6.2 Loop 伪代码

```
while (msg = inbox.claim()):            // inbox = 用户消息 + 工具延期注入 + 审批结果
  log(turn/start)
  do:
    messages = session.projectMessages() + systemPrompt.assemble() + lsp.contextHint()
    stream = llm.stream({ messages, tools: toolRegistry.schemas() })
    for chunk in stream: emit(bus, 'assistant.delta'); settle → log(message/assistant)
    calls = extractToolCalls(stream)
    results = toolScheduler.run(calls, maxParallel)   // 并发池，结果按模型顺序提交
    for each: log(tool/call) → log(tool/result)
    pressure = tokenMeter.check(session)
  while (inbox.hasPending() && !pressure && !aborted)
  log(turn/end, reason)
```

### 6.3 关键机制

| 机制                    | 设计                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **工具并发**            | 按 `concurrency` 分类，滚动并发池（默认上限可配）；`tool/call` 与 `tool/result` 严格按模型输出顺序提交日志，保证重放确定性。                        |
| **取消**                | AbortSignal 贯穿 LLM 流与工具执行；中止时补写合成 `ABORTED` 结果事件，日志不残缺。                                                                  |
| **拦截点（Loop 外置）** | `beforeStep` / `beforeModelCall` / `beforeToolExecute` / `afterToolExecute` 四个拦截点，权限、审计、脱敏、限流均实现为拦截器注册，Loop 本体零侵入。 |
| **LLM 适配**            | 由 `LLM Gateway` 内部用 Vercel AI SDK 的 provider 机制实现 `LLMPort`；重试、fallback 模型、token 计量在此层完成。                                   |

typed `browser` 无论 registry 的 concurrency 设置都形成独占 wave；同 step 首次执行错误或策略拒绝后，后续 browser calls 只记录 `NOT_EXECUTED`，不执行也不再发审批。无关工具保持原调度规则，下一 step 重置失败状态。每 step 最多执行 16 次 browser 调用。取消仍通过既有 terminal/torn-tail 配对。browser 结果跳过 generic spill，保留最终实际交付 receipt；硬曝光上限触发下一 step 的无工具结论路径。

---

## 7. 会话持久化：事件溯源

直接借鉴 dsh 的成熟设计，但持久化到 PostgreSQL 而非本地 JSONL：

- **`session_events` 表**：`(session_id, seq, event_type, payload_jsonb, actor, created_at, prev_hash)`，append-only，`seq` 单调；`prev_hash` 形成哈希链，防篡改（审计要求）。
- **表面投影（projection）**：模型可见消息 = 事件的纯函数投影；compaction **只追加日志事件并 replace 表面区间**，历史永不删除（对应 dsh 的 `surfaceOp: replace`）。
- **完成 turn 的上下文**：活动 turn 只保留当前执行所需 reasoning/tool call/result，普通 progress 文本不进入下一次模型请求；`turn/end` 后历史投影只保留原始用户输入和最终非工具回答（去除历史 reasoning）。没有最终回答时投影明确终止原因，不能把最后一条进度当作成功。contracts 的 `turnMessageProjection` 统一判定 progress/final：新事件写入显式 `phase`，旧日志依据 tool/turn 边界推断；对话 API、模型上下文和 compaction 的输入共用该规则。事件日志、UI 活动回放和审计保留全部记录；skill 快照单独固定，不因工具历史过滤丢失。最终 source metadata 随答案保留，避免后续追问丢失引用。
- **Fork**：复制事件前缀 + `session/forked` 标记，O(1) 元数据操作 + 逻辑视图。
- **取消实现**：REST/ACP Stop 先追加 `turn/cancel_requested(throughPromptSeq)`，再 await `TurnCancellationPort` 的 Redis wake-up；marker 覆盖已提交但尚未执行的 prompt 和重试，未来更高 seq 的 prompt 不受影响。Loop 在 prompt gate 前与每 step 检查持久化 marker；活跃任务经 AbortSignal 立即中断，worker 开始消费前等待 cancellation subscription ready。inline server 也持有并清理每个活跃 turn 的 AbortController。API 返回 `alreadyStopped`，UI 对已终止的旧 turn 清理 loading/approval；活跃 turn 等待 `turn/end`，错误终止也清理 approval；无结果的 pending tool 指示器随 turn 结束标为失败，并保留历史消息对象引用。取消导致的 provider 异常按 aborted 处理；POSIX Bash 命令置于独立进程组，取消/超时对整个命令组发送 SIGTERM，1 秒未退出则升级 SIGKILL，避免只杀 shell 留下子命令。用户已经运行的 CDP Chrome 不在该命令组内。审批 request/reply listener 在 subscribe 前注册，异步 subscription 暴露 ready promise，避免快速消息丢失。回放对所有未闭合 tool call 合成未知结果错误，不自动重复副作用。
- **回放**：worker 崩溃恢复时，从上次 `turn/end` 之后截断的尾部自动合成关闭事件（借鉴 dsh 的 torn-tail 修复）。
- **Compaction**：LLM 生成摘要替换表面区间；摘要边界吸附在 tool call/result 配对处；图像转储（image offload）、大结果 spill 到对象存储仅留引用（借鉴 dsh `spill/`）。
  - **M4 实现备注**：`compaction/summary` 事件携带 `[fromSeq, toSeq]`，投影**原地**替换该区间（摘要占据首个被覆盖事件的位置，时序不变）；边界按"整个交换（用户消息 + 其后全部事件）"吸附，当前 turn 的最新交换永不压缩；compaction 在每个模型请求前与工具波后检查上下文压力（`ContextManager`，可注入 token 估算器）。spill 落在 `BlobStore`（M4 为本地文件系统适配器，S3 可替换），日志仅存 `blob://` 引用 + 预览，`read_blob` 工具取回。

---

## 8. 工具系统

首批内置工具（优先级从高到低）：

| 工具                                     | 说明                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`                                   | 经 Sandbox 执行 shell，支持持久会话、沙箱升级需审批；文件内容读取应使用 `read_file`                                                     |
| `read_file` / `write_file` / `edit_file` | `read_file` 负责工作区文本检查；模型指引优先使用它而非 Bash 的 `cat`/`sed` 等。edit 采用 str-replace 语义（强制模型先读再改，减少误改） |
| `glob` / `grep`                          | 代码检索（rg 后端）                                                                                                                     |
| `web_search` / `web_fetch`               | 联网能力（可配置关闭）                                                                                                                  |
| `browser`                                | saved read/search；live capture 仅在注入满足 §12 的 BrowserAccessPort 时启用，见 §8.2                                                   |
| `research`                               | 有界的研究问题、claims/引用与未决问题；工具结果留痕，来源校验使用当前 turn 的成功 browser read 结果                                     |
| `todo`                                   | 任务规划                                                                                                                                |
| `lsp_*`                                  | `lsp_diagnostics` / `lsp_symbols` / `lsp_hover` / `lsp_rename`                                                                          |
| `ask_user`                               | 向用户提问（阻塞 turn 直至回复）                                                                                                        |
| `subagent`                               | 派生子 Agent（独立上下文，结果回收）                                                                                                    |

工具实现遵循 §5.2 的 `ToolDefinition`：execute 返回规范化 JSON 值，`render` 负责生成模型可见内容——**测试与 UI 展示都可复用同一渲染层**。

Loop 的系统指引要求模型用 `read_file` 检查工作区文本、用 `glob` 定位文件，Bash 用于运行命令、测试、构建与版本控制操作。敏感文件路径由 agent 在工具执行前检查并通过正常审批流授权；模型直接调用 `read_file`，没有独立的 permission tool，也不得改用 Bash 绕过审批。模型不得在最终答复中复述秘密值。维护列表见 `packages/core/src/tools/sensitive-files.ts`。

### 8.1 Runtime Skills

Skill 是 Markdown 指令包，执行能力仍来自已有工具。借鉴 dsh 的独立技能目录/服务边界和持久化 catalog，以及 oc 的摘要发现 + 按需加载：`packages/core/src/skills` 实现 Skill Runtime，端口和 DTO/Zod schema 定义在 contracts，server inline、agent-worker 与 worker subagent 在 composition root 注入同一能力。不引入 MCP 或插件依赖。

- **来源与隔离**：只扫描当前 session sandbox root 下的 `.trinity/skills`、`.agents/skills`、`.claude/skills`，以及管理员显式配置的 `SKILL_DIRS`（JSON 路径数组）和发行版 `skills/`。依次优先，重复名称首个有效定义胜出，目录内按路径排序。禁止向 workspace 父目录或宿主 HOME 自动查找，禁止符号链接逃逸；读取、递归深度、目录数、skill 数都有上限。workspace skill 是当前用户提供的指令，不能修改服务端权限、密钥或 egress 策略。
- **格式与发现**：标准 `SKILL.md` YAML frontmatter（name、description），可选 `disable-model-invocation`、`user-invocable`。无效文件只产生不含正文的诊断，并从可调用 catalog 中移除。服务无会话内存状态，每 step 从来源重新发现；file hash 标识版本。已加载且仍可由模型调用的活跃 skill 在来源版本变化时追加新的 `skill/loaded` 快照；旧 tool/result 在模型投影中标记为已被取代，历史日志不修改，避免更新后会话继续执行旧指令。
- **渐进加载**：模型先看到 name/description 的 catalog，根据任务选择调用 `skill(name)` 加载完整正文；此接口只加载指令，不执行 skill 中的命令。`skill(name, resource)` 按需读取同目录文本资源，执行脚本仍经 Bash/Sandbox 和现有审批。用户可用 `$skill-name` 显式加载，未知、禁用或策略拒绝时明确失败；明确调用的正文在首个模型请求前入日志；同一 prompt 的显式指令超过 128 KiB 时原子拒绝。`skill: ask` 的摘要仍可发现，模型加载经普通审批；显式加载未取得审批时拒绝。
- **持久化**：catalog 变化追加 `skill/catalog`（摘要与渲染后的指令），显式加载追加 `skill/loaded`（完整版本快照）；模型加载的正文/资源在普通 `tool/result` 中记录。所有 model-visible skill 内容均可从 PG log 重放，不依赖重启后文件内容。最新 catalog 在 compaction 后重新投影；已加载 skill 按最近使用顺序，在 128 KiB 指令预留预算内保留最新版本快照，避免摘要遗失操作规范或无限累积旧指令；更旧快照仍在日志中，可按需再次加载。当前 session 标识在 catalog 中持久化，fork 后刷新，避免浏览器隔离复用父会话标识。历史 skill 内容不进入 UI 普通聊天消息。未完成的 skill call 在回放投影中合成可重试中断错误，不自动执行或假装已加载。
- **发布**：发行版安装 `skills/agent-browser/SKILL.md`，默认指引模型使用当前 schema 公布的 typed `browser` operations。catalog 只描述部署已配置连接及 adapter 管理连接/tab，不向普通任务提供 CLI 命令模板；skill 中的阅读、交互与研究示例全部使用 typed operations。CLI troubleshooting 保留为按显式 operator 请求加载的 `references/cli-diagnostics.md`，现有 Bash 权限不变。server/worker Docker 镜像包含 skill 目录。管理员显式配置 `BROWSER_CDP_ENDPOINT`；adapter 负责命名 session、`--cdp`、`--pin-tab`，连接失败不启动替代浏览器、不关闭用户 Chrome。子 agent 或受限 registry 只使用自身 schema 公布的 saved/live 能力，不从部署已配置连接推断 live 权限。未配置时仅 saved reads，不自动发现或启动 managed Chrome（部署指南 TODO）。共享 CDP 仅隔离 tab，cookies/auth 仍共享，不作为租户隔离机制。Sandbox minimal env 保留 `XDG_RUNTIME_DIR`；底层 CLI 与浏览器安装及网络许可仍为独立部署前提，skill 不赋予执行权限。

---

### 8.2 Browser / Research：typed 交互与上线门槛

详细方案与分阶段验收见 [browser-research-improvement-plan.md](./browser-research-improvement-plan.md)。`core/tools/browser*` 已实现 typed browser：contracts 的 operation DTO、Sandbox argv/流式字节上限、CLI capture adapter、canonical hash artifact、按 block/section/cursor 读取、literal search、实际曝光 receipt、软/硬 turn budget、同 step 失败跳过及 research block 引用。server/worker 在显式配置 `BROWSER_CDP_ENDPOINT` 时装配 `TrustedCdpBrowserAccess`，公布 navigate/read_page/get_page_text、scoped snapshots、click/fill/key/scroll 和截图；未配置则仅 saved read/search。本机使用已有 CDP Chrome 9222，不启动 managed Chrome（部署指南 TODO）。现有 Skill + Bash 仍为 legacy live 路径，不具备整个部署的强制 browser 预算/隔离保证。

只读 artifact 使用 `blob://browser/<encoded-session>/<observation-id>.json`，schema/extractor version 均校验；hash 为排序 object keys、保留 array 顺序的 JSON，去掉 hash 字段后做 SHA-256。block text 的 range 是 Unicode code-point 零基半开区间。授权由同 session 成功 tool/call/result 决定，fork 复制的父会话 receipts 不授予读取权；不跨会话继承 browser binding。每次 saved retrieval 重验大小/schema/hash。capture time 不变，saved 标记区分历史观察与 live visit。`read_blob` 和通用 HTTP blob endpoint 拒绝 browser 命名空间；默认保留所有 browser artifact，未引用 orphan 不授予证据权，也不自动删除（部署 GC 尚待实现）。

`BrowserAccessPort.authorize` 区分 `trusted-cdp` 与未来 `enforced` 部署。当前按用户要求使用 trusted CDP：逐次校验已认证个人会话属于配置 owner（`BROWSER_CDP_OWNER_ID`，缺省为 `ADMIN_EMAIL` 对应账号），拒绝团队/其他用户/其他 tenant/关闭会话；M1 无鉴权模式仅用于同一机器的可信本地使用。effect 前后校验连接与最终 URL；CLI 固定支持 0.38.x，端口/HTTP discovery 与实际 WebSocket URL 按 host/port/security/path 正确比对。命名 session/--cdp/--pin-tab 每次都传；从 committed receipt 恢复实际 CDP targetId 后按 ID 绑定，不向模型返回其他 tab inventory、不重开用户 Chrome。绑定来源是本会话事件，fork 不继承控制权。trusted CDP 保留共享 cookies/账户及现有 Bash 的限制，不声称 egress、隐私或整个部署隔离。未来 enforced 模式的网络、下载、隐私、takeover 与替代控制路径关闭要求仍须部署侧实现；managed Chrome 留在 [deployment-guide.md](./deployment-guide.md) TODO。

当前实现包括只读 DOM role/name/path 投影与原生 accessibility 文本、scoped r refs、checked click/fill/key/scroll、viewport/cropped PNG、可选可见文本 readiness、Readability 对照 fixture 与显式 opt-in live/model 对照 runner。target path 仅保存在 hash artifact 内，不让模型提供 selector。native button/link 用固定、经校验的 DOM click 激活，避免当前 CDP CLI pointer acknowledgment 未触发 visible outcome 的问题；其他 ref/坐标仍走 checked pointer 路径，未知效果不得自动重试。DOM click 不提供 trusted user gesture；需要该手势的网站必须显式请求 pointer/key 并重新观察。截图等待 compositor frame 超时仍保存实际 pixels，但标记 partial、提示可能落后 DOM，并拒绝从该 image 发起坐标操作。执行前重新提取 fingerprint（角色/名称/path/geometry、viewport/scroll/locale/timezone）并校验最近 committed live snapshot、实际 binding/tab/document；失败或未知 outcome 使旧 target 失效。此校验不会将 live DOM/CDP 竞争变成原子事务：共享 Chrome 的用户/并行输入仍可能改变效果，readiness 和 post-action observation 说明实际覆盖，不声称 deterministic browsing。

browser 动作默认逐操作 ask；`browser.click` / `.fill` / `.key` / `.scroll` 是显式策略项，`browser: allowed` 和 Bash executable grant 不授予这些动作权限，tool deny 优先。Loop 在持久化审批结果或显式策略允许后才注入 `permissionGranted`。无策略的本地动作同样 fail-closed 走审批。截图使用 `pngjs` 做有界 PNG 解码/crop，2 MiB/张、2048×2048、4 张/turn、6 MiB/turn；只从 bounded Sandbox binary transfer 读入，临时文件 finally 删除。image hash/size/crop/scale 与 observation、successful receipt 一起提交；gateway 按现有 image content path 编码，不把 base64 放进 tool JSON。model resolver 重验当前 turn receipt/session/hash；UI 专用 `/api/sessions/:sessionId/browser-images/:observationId` 经会话鉴权后可展示 retained evidence，generic blob API 继续拒绝 browser namespace。截图不会建立 canonical text blocks/quotes。敏感 URL 与已识别的敏感/可编辑控制无法安全捕获时拒绝；这不是任意私密页面的完整自动脱敏保证。

Readability 仅为开发期选择器对照依赖，当前保留 semantic extractor 的精确 code/table/标点结构，不把 Readability 重写的 textContent 变成 canonical evidence。自动化 GC 未开启：所有 event/citation 引用及未提交 orphan 默认保留；部署必须依据完整保留日志引用集合，在超过最长执行/恢复窗口后清理确认无引用的 browser blobs，不能从 Redis 截断或 fork 副本推断所有权。下列边界仍是 trusted CDP 之外的部署目标：

参考 Anthropic 的 [browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool) 与 [SDK 指南](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk)，采用按任务选择表示、有序执行与应用端校验的模式；具体的持久化、预算、授权和引用规则由 Trinity 定义。保持 Vercel AI SDK 的 provider-neutral custom tool，不引入供应商专属执行通道。

- **能力归属**：typed `browser` 是既有 Tool Runtime 的内置工具，adapter 位于 `core/tools`，DTO/Zod schema 置于 contracts；依赖 SandboxPort、BlobStore、SessionStore，由 apps composition root 装配。不新增独立 browser service 或 plugin framework。先补足 Sandbox 的 argv/输出流上限能力，避免 `exec` 全量累积后再裁剪。
- **最小接口**：`operation` 判别联合；先实现 navigate、只读 scoped accessibility `read_page`、visible `get_page_text`，再加入 saved read/search、受限 screenshot 与 click/fill/scroll/key。每次只请求一个 operation；同 step 浏览器调用按序运行，首次错误/拒绝后剩余 browser calls 返回 `NOT_EXECUTED`。禁用任意 model-authored JS、原始 CDP、文件上传和全量诊断输出。
- **表示与反馈**：交互优先 accessibility refs，阅读保留 visible semantic blocks，视觉问题使用截图；内部固定 extractor 在 live tree 上判断可见性后再 clone，不把 hidden body source 当作普通证据。操作返回简短确认及有界 post-action observation，确认驱动执行成功不等于任务目标成功。明确 readiness 与 partial capture，不用 network idle 保证完整性。
- **身份与生命周期**：初版仅使用会话拥有的 pinned tab。交互 target 必须绑定已交付 snapshot/reference 或 screenshot/viewport，导航、重连、相关 DOM/viewport 变化后拒绝失效目标；不得把旧 ref 重映射到新元素。用户接管时暂停 agent；超时、断连或动作后存储失败返回明确 effect status，未知结果先重新观察，不能重试副作用来恢复日志。
- **持久化与确定性**：observation 先以不可变 artifact 保存，成功 `tool/result` 记录其引用和实际交付的 block/range/image receipt；无成功 event 的 blob 不是证据。确定性保证覆盖已保存观察的校验、读取、范围解析与 replay，不保证实时网页或模型决策可重复。canonical block text 使用 Unicode code-point 的零基半开区间，UTF-8 byte budget 单独计算。内容 hash 验证 artifact 完整性，不证明网站真实。
- **上下文预算**：分别限制 capture、response、diagnostics 与 images；软阈值后仅允许 focused reads，硬阈值同样约束 focused reads，并预留 limit diagnostic allowance。response fitting 先计入 continuation，再为正文/receipt 预留最多 2 KiB（不超过当前 response allowance 的一半），裁剪可选 snapshot targets/outline；完整 artifact 不变，snapshot 显式标记 truncated。逐 block fitting 保留已验证能放入 response 的 cursor，最后统一计算 truncation，避免 dense page 首次导航被误报预算耗尽或 block 边界溢出。receipt 从 PG log 重放，累计唯一/重复交付；所有 artifact retrieval routes 一致鉴权、限额，generic spill 不得改变实际曝光却保留错误 receipt。
- **研究与展示**：新 notes 用 observation/block/range，由服务端按当前 turn 成功交付 receipt 解析原文、URL、callId/evidenceSeq；旧 quote/URL validator 继续支持 legacy events。旧 observation 当前 turn 可授权 reread，保留原 capture time，不冒充 fresh visit。Sources / View evidence 沿用既有 contracts DTO；来源仍不证明 claim 的语义正确。
- **迁移边界**：search/fetch 若以后可用，适合普通文档且必须遵循相同 evidence contract；当前 core registry 未实现 §8 列出的 web_search/web_fetch，不作为首版前提。不要求 browser subagent。继续保留当前 Bash 描述；只有关闭模型可绕过 wrapper 的 Bash/CDP/全量 artifact 路径后，才可宣布强制预算和动作边界生效。

安全前置条件见 §12：权限属于每个 operation 的实际目标，网络限制属于 browser 所在环境；既有 CLI prefix grant 不自动授权 typed browser 行为。量化收益通过固定任务的分阶段重复对照测量，不预先声明百分比。

---

## 9. LSP 集成

- 技术：`vscode-languageserver-protocol`，每个工作区根目录惰性启动一套 language server（Python→pyright、TS/JS→typescript-language-server、JSON/YAML→vscode-json-languageserver/yaml-language-server；二期加 Java（jdtls）、Rust（rust-analyzer））。
- **进程模型**：agent-worker Pod 内运行 LSP 进程池，按 workspace 缓存；worker 缩容时优雅 shutdown。
- 对 Loop 的暴露：LSP 能力通过 `lsp_*` 工具供模型主动调用；同时 **diagnostics 作为自动上下文注入**——在 `beforeStep` 拦截点收集当前会话涉及文件的诊断信息，注入 system prompt 区域（带缓存与失效策略）。
- 伸缩考虑：LSP 进程是 worker 内存大头，配置 per-pod 上限 + LRU 回收。
  - **M4 实现备注**：语言服务器进程经 `SandboxPort.openProcess`（长生命周期 stdio 双工，唯一允许的 spawn 路径）拉起，JSON-RPC 由 core 内的 `LspConnection`（Content-Length 帧）实现；进程池按 `(workspaceRoot, lang)` 惰性启动、单飞（single-flight）、`LSP_MAX_SERVERS` LRU 回收、`dispose()` 确定性关闭。diagnostics 自动注入实现为 Loop 的 `augmentSystem` 钩子：扫描会话日志近期工具调用涉及的文件（≤5 个），每步前拉取诊断拼进 system prompt，失败降级为空注入。

---

## 10. 多模态支持

| 能力             | 设计                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 输入             | 前端上传图片/PDF → Multimodal 模块存对象存储（S3/MinIO）→ 生成 `file` part（AI SDK 标准格式）注入消息；PDF 走文本抽取 + 页图双通道 |
| 模型侧           | `LLMPort` 消息直接携带 AI SDK 的 `ImagePart`/`FilePart`，由 Vercel AI SDK 按 provider 能力编码                                     |
| 输出             | 图表生成（mermaid/代码）前端渲染；图像生成工具预留                                                                                 |
| 上下文成本       | 图片超过阈值时压缩/转储，引用代替内联（offload）                                                                                   |
| 会话中的历史附件 | 事件日志只存引用（URI + 摘要），内容在对象存储                                                                                     |

**M4 实现备注**：`BlobStore` 端口（`blob://` URI）+ 本地文件系统适配器（server 与 worker 共享 workspace 磁盘；S3/MinIO 适配器可替换）。上传走 `POST /api/sessions/:id/attachments`（octet-stream，MIME 白名单 image/png/jpeg/webp/gif + application/pdf，20MB 上限），`GET /api/blobs/<key>` 取回（UI 渲染/模型取回）。PDF 文本抽取用纯 TS 的 `pdf-parse`，抽取文本存为伴生 blob 并作为 text block 注入；**页图渲染通道暂缓**（Node 侧无原生 canvas，留待 M5+/客户端渲染）。多模态 block 经 `LLMRequest.resolveBlob` 在网关侧编码为 provider 原生 image/file part（fail-closed：无法解析 ⇒ 报错，不静默丢附件）。

---

## 11. 前后端协议：Browser 即 ACP Client

### 11.1 设计决策：SSE + POST，全面复用 /acp

- **浏览器端不使用 WebSocket**。传输只有两种原语：
  - **POST**（客户端 → 服务端）：所有客户端发起的请求与命令。
  - **SSE**（服务端 → 客户端）：所有服务端推送（流式输出、工具状态、审批请求）。
- **浏览器与 Zed/编辑器共用同一套 ACP 语义**。服务端只实现一份 ACP 方法集，通过两种 transport 暴露：
  - **stdio transport**：`acp-gateway` 进程，供 Zed 等编辑器 spawn（NDJSON over stdio，官方 `@agent-client-protocol/sdk`）。
  - **HTTP transport**：`server` 直接暴露，供浏览器使用（借鉴 ACP 的 streamable HTTP 思路，但实现极简：POST + SSE 即可）。

由此前端不需要第二套私有协议——**Web UI 就是一个 ACP client**，antd 组件直接消费 ACP 消息类型。非 ACP 的纯控制面（登录、用户管理、审计查询等）走普通 REST。

### 11.2 HTTP binding 定义

```
POST /acp
  Content-Type: application/json
  Body: JSON-RPC 2.0 请求或通知（单条）
  → 返回 JSON-RPC 2.0 响应（request 有响应；notification 返回 202）

GET  /acp/stream?sessionId=<id>[&afterSeq=<n>]
  Accept: text/event-stream
  → SSE 流：每个 SSE event 携带一条 JSON-RPC 消息
    - request 的 response
    - 服务端主动 request（如 session/request_permission，客户端通过 POST 回 response）
    - notification（session/update、session/cancelled 等）
```

- 浏览器原生 `EventSource` 即可消费（除 `POST` 需要 `fetch`）。
- 所有 JSON-RPC 消息 schema 用 zod 定义，前后端共享（`packages/shared/acp-schema.ts`）。

### 11.3 断点续传与有序投递（关键设计）

**答案：是的，SSE chunk 必须携带顺序 ID——而我们已经免费拥有它。**

事件溯源日志中的 `seq`（见 §7）就是全局单调序号。SSE 直接复用它：

```
event: session/update
id: 1042                          ← SSE 原生 id 字段 = 事件日志 seq
data: { "jsonrpc": "2.0", "method": "session/update", "params": {...} }

event: session/update
id: 1043
data: { ... }
```

**重连与续传流程：**

1. **浏览器断线**（网络抖动、切 tab、Ingress 重载）：`EventSource` 自动重连，且按 SSE 规范**自动携带 `Last-Event-ID: <最后收到的 id>`** 请求头（浏览器内建行为，无需代码干预）。
2. **页面刷新/重新打开**（EventSource 无记忆）：前端将会话 `lastSeq` 持久化在 `sessionStorage`/IndexedDB，重建连接时显式传 `?afterSeq=N` 查询参数（EventSource 不支持自定义请求头，故用 query 参数作为显式路径，服务端两个入口都接受）。
3. **服务端恢复**：
   - 收到 `Last-Event-ID` 或 `?afterSeq=N` → 从 PG `session_events` **按 seq 严格递增重放**所有缺失事件 → 追上后无缝切换到 Redis Stream 实时流。
   - 未携带（全新连接）→ 只推实时事件；历史由客户端显式调 `session/load` 拉取。
4. **缺口检测**：客户端发现收到的 `id` 不连续（跳号）→ 主动断开并用最后一个 `id` 重连，触发服务端重放补齐。服务端按 seq 严格顺序写 SSE，**跳号永远只可能是遗漏，不可能是乱序**。
5. **心跳**：每 15s 一个 `: ping` 注释行（SSE 注释，不占用 seq），客户端据此区分"无事件"与"连接已死"；超时未收心跳则主动重连。
6. **重连退避**：`1s → 2s → 4s → … → 30s`（上限）+ 随机抖动；重连成功后重置。

**POST 侧的可靠性（与续传互补）：**

| 问题                         | 设计                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| prompt 重发导致重复          | 客户端为每个 `session/prompt` 生成 `clientRequestId`（UUID，置于 JSON-RPC `id` 或 `_meta`）；服务端记录已处理 ID，重复请求返回首次响应（幂等） |
| 重连后不知道 prompt 是否到达 | 响应本身可重放：重连后客户端可用同一 `clientRequestId` 重发，命中幂等表                                                                        |
| 审批回复丢失                 | 审批结果也是事件（`approval/replied` 落事件日志），重连后从日志重放可确认状态                                                                  |

**事件溯源 ⇄ SSE 对齐总表：**

| 层                                  | 序号                   | 用途                  |
| ----------------------------------- | ---------------------- | --------------------- |
| PG `session_events.seq`             | 事实源，单调递增       | 审计、重放、fork 边界 |
| Redis Stream entry id / payload seq | 分发层                 | 多实例扇出            |
| SSE `id:` 字段                      | = `session_events.seq` | 客户端断点续传        |

PG 是唯一事实源：即使 Redis Stream 被截断、SSE 连接中断，任何客户端都能从 PG 精确重建任意 seq 之后的事件流。

### 11.4 ACP 方法集（对齐 opencode 的覆盖面）

- Agent 侧（客户端 POST 发起）：`initialize` / `authenticate` / `session/new` / `session/load` / `session/list` / `session/resume` / `session/close` / `session/unstable_fork` / `session/set_config_option` / `session/set_mode` / `session/prompt` / `session/cancel`
- Client 侧（服务端经 SSE 下发，客户端 POST 回 response）：
  - `session/update`：消息/思考 chunk（`agent_message_chunk` / `agent_thought_chunk`）、`tool_call` 状态机（pending → in_progress → completed/failed）、`usage_update`
  - `session/request_permission`：审批请求 → 前端 antd Modal → 结果经 POST 回传，映射到内部 `ApprovalPort`；客户端不支持该方法时自动拒绝（fail-closed）
  - `fs/write_text_file`：edit 类权限由客户端（或浏览器端经 REST）自行落盘
- **会话 1:1 映射**：Web 会话与 ACP 会话指向同一 `session_events` 日志，用户在浏览器和 Zed 中看到完全相同的会话。

### 11.5 前端会话层（React）

- 每条用户与 Assistant 消息显示本地时区日期 / 时间，悬停可查看完整时间；`message/committed.message.at` 是向后兼容的可选字段，来自日志事件的 `at`，回放保留原始时间。乐观消息先用本地发送时间，提交后以日志时间校正；旧协议缺少时间时明确显示不可用，不伪造历史时间。Assistant 响应以全宽卡片显示，保留 Markdown、工具调用折叠区与流式状态；完成且有正文后显示复制 / 赞 / 踩操作。复制经浏览器 Clipboard API 写入完整 Markdown，失败提示手动复制；评分仅为当前视图内的互斥可取消选择，尚不持久化或发送到服务端。操作状态在独立 memo 组件内，避免操作时重绘正文与历史。

- 视觉与排版：界面与 antd theme 共享 CSS 字体变量，正文使用 `system-ui` 原生平台字体（Apple 的 San Francisco、Windows 的 Segoe UI、Android 的 Roboto，Linux 按系统配置选择），代码使用 `ui-monospace` 与本地等宽字体回退；不依赖远程字体，以避免加载时布局偏移及外部网络依赖。低对比度的中性背景与绿色强调色用于区分导航和主内容，消息正文保持可读的行高与宽度。手机首次打开时折叠历史栏，为对话保留空间，用户可以随时展开；移动端使用 44px 操作目标、16px 输入字号及安全区内边距；支持键盘焦点与减少动态效果偏好。

- 轻量 ACP client 库（`packages/client-acp`）：封装 `EventSource` 生命周期、重连退避、`Last-Event-ID` 管理、JSON-RPC request/response 配对（`id` → Promise）、缺口检测。
- 状态管理：事件 reducer 将 `session/update` 折叠进 `createStore`/`zustand` store（消息 part 增量合并，delta 聚合）。
- antd 组件与 ACP 消息类型一一对应：`session/update(tool_call)` → ToolCall 折叠面板；`request_permission` → 审批 Modal。
- Web UI（apps/web）：左侧会话历史栏（`GET /api/sessions`，点击经 SSE `afterSeq=0` 重放日志还原会话）；工作区选择器（个人 / 我所属的团队，`POST /api/sessions` 的 `workspace` 字段）；assistant 消息以 Markdown 渲染（react-markdown + remark-gfm）。
- 输入草稿保存在独立的 composer 组件内，避免每次按键重新渲染历史栏和消息列表；消息使用稳定的 render 函数和 memo，流式更新只重绘变化的消息。首次创建会话、流式响应和布局调整保留 textarea 节点及草稿；显式新建或切换会话才清空草稿。DOM 回归测试使用 jsdom 和模拟 ACP client，检查焦点、草稿以及未变化消息的渲染次数；Vitest 内联 antd / antd-x 依赖以解析其 ESM 导入。
- 每个用户 prompt 只有一个 assistant response，所有 step 更新同一个稳定节点。progress commit 与 tool step 的临时正文保留在默认折叠的 Execution details；进行中的 response 在正文上方显示有界 Task progress 卡片，直接展示最新 progress、当前工具标题与 queued/running 状态，最多默认显示 4 个并行调用，其余可展开。审批等待、取消和错误状态直接可见；最终 synthesis 替换主正文，卡片收为完成摘要，历史与工具输出仍可展开。调用计数仅表示 tool calls，不推算子任务完成比例；结构化计划与子 Agent 内部进度尚未接入。流式 provisional text 仍即时显示。旧日志 replay 同样按 tool/turn 边界合并，取消/错误后的 progress 不作为最终答案，late chunks 不重开已结束的 response。用户消息通过保存的 event ID 区分相同文本的不同 turn，避免吞掉重复提问。
- 最终回答使用 Trinity (`~/sources/trinity`) 的 **Sources → View evidence** 展示思路：正文用 Markdown links，Sources 计数与 Evidence drawer 按 web source、workspace reference、research claim 展示文档标题、URL/文件位置及有界 excerpt。Zod citation DTO 定义在 contracts，经 shared 重导出（shared 仅增加对 contracts 的依赖，contracts 仍无实现依赖）；最终 `message/assistant` 事件与 ACP `_meta` 携带 `citationList`，SSE/刷新/导出可重放。Loop 从当前 turn 的成功 browser extraction、read_file 和验证过的 research notes 构建最多 60 条引用，携带原始 callId/evidenceSeq；spill 按受限 session blob 恢复，不从模型随意输出的链接制造 grounding。source list 表示观察来源，不保证 claim 语义正确。无来源的普通对话不伪造 citation。
- 实时文本 / 思考 chunk 不参与持久化日志 seq 去重，也不推进恢复游标：浏览器 EventSource 会让没有 `id:` 的 Pub/Sub 帧继承上一条已提交事件的 ID，按该 ID 去重会吞掉整个实时响应。已提交事件仍按 seq 去重与重放。没有本地占位消息时（重开运行中的会话或同一 turn 的下一模型 step），文本 chunk 创建或更新当前 turn 的唯一流式 Assistant response，提交后原位替换正文；不等待 turn 完成才展示。
- Composer 使用 `@chenglou/pretext`（参考 `/home/sam/sources/trinity/frontend` 的测量思路）替代 antd textarea 的逐次 DOM autosize 测量，避免输入与流式响应竞争同步布局。DOM 字体 / 内边距 / 宽度在挂载与宽度改变时缓存；内容变化时 `prepare`，同内容调整宽度只做 `layout`，ResizeObserver 忽略仅由自身高度改变引起的通知并在卸载时断开。保留原有 Sender 提交、IME、焦点与草稿行为。

---

## 12. 安全、权限与审批

1. **工具执行策略**（每会话可配，预置模板借鉴 dsh 的 permission-presets）：
   - `workspace-write + ask`（默认）：工作区内写自由，危险命令需审批；
   - `read-only`：只读；
   - `danger-full-access + never`（CI 场景，其它工具调用不审批；敏感文件清单仍需审批）。
   - `commandPrefixes` 支持管理员配置的 literal argv 前缀白名单，workspace-write 默认含 `agent-browser`。匹配仅接受单一 literal 命令，拒绝 shell composition/expansion，仅允许一个有限行数的 stdin `head`/`tail` 输出过滤器（无文件参数、文件重定向或后续命令；可合并 stderr 到 stdout `2>&1`）；不通过字符串 startsWith 授权，不允许同名后缀 executable 绕过。显式 tool denied 始终优先。
   - `packages/core/src/tools/sensitive-files.ts` 维护敏感 workspace 文件匹配列表。命中列表的 `read_file` 路径在读取前触发 agent-owned 审批，即使普通 read 或 wildcard policy 为 allowed；命令中直接引用敏感路径的 Bash 调用也触发审批，且不能由可复用 command-prefix grant 自动放行。`.env.example`、`.env.sample`、`.env.template` 是模板例外。该检查补充模型指引，不是对任意动态 shell 文件访问的 OS 级拦截。
   - 审批 UI 支持一次或当前 conversation 的 executable/argument-prefix approval。REST 鉴权后核对当前 session 的待决请求和实际 Bash call，先追加 `approval/command_granted` 再通知 worker。Loop 从 PG event log 读取授权，跨 turn/restart 生效，不能覆盖 denied 或绕过沙箱。无原始命令的截断预览不能定义权限。
2. **审批流**：工具命中策略 → `ApprovalPort.request` → 事件发布到 Redis Stream → API Server 推送到前端对话框（或 ACP `session/request_permission`）→ 结果写回事件日志（**审批请求与结果均留痕**）。无应答器时 fail-closed。
3. **Sandbox**：v1 在容器内运行（K8s Pod 内嵌套隔离 + 文件系统只读挂载 + 网络策略）；预留接口切换 gVisor / Firecracker microVM；越权操作必须经审批后升级。
4. **RBAC**：租户 → 角色（admin/developer/viewer）→ 会话与工具策略；密钥（模型 API Key 等）由服务端统一托管（K8s Secret + 信封加密），**永不下发前端**。
5. **输入输出安全**：prompt 注入提示、工具结果大小上限、出站网络 egress 白名单。

**Browser 改进的上线安全边界（trusted CDP / 未来 enforced 部署，§8.2）**：导航只接受解析后的无凭据 HTTP(S) URL，逐操作校验实际目标与持久化授权，明确区分站点读取、填写与提交/购买/发送等行为。browser 所在网络边界须默认拒绝未授权出站，覆盖重定向、子资源、脚本请求、WebSockets、service workers、DNS 解析后的目标 IP，并限制 private/link-local/loopback 与控制端点；worker 的 NetworkPolicy 不能代表远端 CDP Chrome 的出站限制。这些是未来 enforced 部署的门槛；当前明确配置的 trusted CDP 使用现有权限与 owner 校验，不宣称具备上述网络边界。managed research profile 不实现、不启动，留作部署指南 TODO；显式用户 CDP 仅限同一认证 owner/trust domain，pinned tab 不隔离 cookies/accounts。下载默认阻止或隔离，上传禁用；敏感 URL、表单值与截图区域在持久化前处理。模型可直连 browser control 或经 Bash 绕过 adapter 时，不得宣称已有隔离/预算保证。

---

## 13. 审计（企业级一等公民）

- **审计 = 事件日志的投影**。所有敏感面（登录、会话创建、prompt、工具调用与参数、审批请求/结果、策略变更、配置变更、数据导出）都以 `audit/*` 事件进入同一事件溯源体系，哈希链保证不可篡改（§7）。
- **独立审计消费者**：一个单独的 K8s Deployment 以 Redis Stream consumer-group 消费 `audit` 流，写入 `audit_log` 表（列式友好字段：who/tenant/what/when/result/ip/session），支持企业 SIEM 外发（Webhook/Kafka，预留）。
- **留存与合规**：可配置留存策略（热 PG + 冷对象存储），支持按租户导出、WORM 模式预留。
- **查询**：前端 antd 表格 + 过滤器（时间/用户/会话/工具/结果），管理员角色可见。

---

## 14. Redis Stream 全局事件分发

| 用途            | 设计                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事件总线        | 每会话一个 Stream（`sess:{id}`）+ 全局流（`global`）；事件 append 后由 worker `XADD`，所有订阅方（API Server、审计、配额、其他 worker）以 consumer group 消费 |
| 扇出            | API Server 每个 SSE 连接订阅对应会话流，实现多浏览器 tab / ACP stdio 客户端同屏同步                                                                           |
| 重放            | 新订阅者以 `XREADGROUP` 从指定 offset 消费历史；断线重连用 `last-seq` 增量补发（详见 §11.3，与 SSE `id:` 对齐）                                               |
| 容量            | 每流设 `MAXLEN ~ N`（近似截断），**事实源始终是 PG**，Redis 只是分发层，截断不丢数据                                                                          |
| 其他 Redis 用途 | Pub/Sub：低延迟信号（中断、心跳）；分布式锁：会话独占执行（同一会话同时只有一个 worker 运行 Loop）；BullMQ：任务队列                                          |

---

## 15. 数据库概要（PostgreSQL）

**Schema 变更工作流（Drizzle Kit，强制）：**

1. 修改 `packages/db/src/schema.ts`（Drizzle 表定义）；
2. `pnpm db:generate`（即 `drizzle-kit generate`）生成 SQL 迁移到 `packages/db/migrations/` 并入库审查；
3. `pnpm db:migrate`（即 `drizzle-kit migrate`）应用迁移——本地、CI（services postgres:16）、生产共用同一入口；
4. 自定义 SQL（触发器、约束、索引调优）允许追加进迁移文件（如 `session_events` 的 append-only 触发器），但表结构本身必须可复现于 schema.ts；
5. 禁止 `drizzle-kit push` 进入 CI/生产流程（仅本地试错可用），禁止运行时改表。

```
users(id, email, password_hash, role, created_at)
tenants(id, name, quota_jsonb)
sessions(id, tenant_id, user_id, title, workspace_uri, scope, scope_id, policy, forked_from, created_at, closed_at)
teams(id, tenant_id, name, created_at)
team_members(team_id, user_id, role, created_at)   -- PK(team_id, user_id)；role: owner | member
session_events(session_id, seq, type, payload jsonb, actor, prev_hash, created_at)  -- append-only
audit_log(id, tenant_id, user_id, session_id, action, target, result, ip, detail jsonb, created_at)
approvals(id, session_id, tool_call_id, request jsonb, outcome, decided_by, created_at, decided_at)
model_usage(id, tenant_id, session_id, model, input_tokens, output_tokens, created_at)
api_keys / credentials(id, tenant_id, kind, ciphertext, created_at)
```

**每会话工作区（workspace scope）**：个人空间的允许根目录是 `$WORKSPACE_ROOT/<user_id>`。用户创建会话时可以选择该根目录，或通过 `GET /api/workspaces/personal?path=<相对路径>` 逐级浏览并选择其中已有的任意子目录；`POST /api/sessions` 的 `workspace: { scope: 'personal', path?: string }` 把选中的目录绑定为会话的 `workspace_uri`，省略 `path` 即选择用户根目录。路径必须是根目录内的相对目录，拒绝 `..`、绝对路径、不存在的目录及符号链接，不能跨用户访问。团队空间仍为 `$WORKSPACE_ROOT/<team_id>`（`scope='team'`，`scope_id` 指向 `teams`）。team 是租户内的用户组（M:N，创建者为 owner），一个用户可属多个 team。会话创建时 fail-closed 校验团队成员身份并 `mkdir` 该目录；Loop/Sandbox 按会话的 `workspace_uri` 构建（server inline 与 agent-worker 均按 root 缓存 sandbox + registry），sandbox 的路径逃逸校验即用户/团队之间的隔离边界。团队会话对全体团队成员可见（`listForIdentity`：自己的会话 ∪ 我所属 team 的会话；admin 见全租户）。团队管理 API：`GET/POST /api/teams`、`POST /api/teams/:id/members`（owner 或 admin）。

**历史会话操作**：无标题会话（如先上传附件）在首个 prompt 到达时原子写入标题。`GET /api/sessions/:id/export` 返回鉴权后的 JSON 对话投影（包含内容块引用）；`DELETE /api/sessions/:id` 仅限所有者或租户 admin，先取消 turn、追加 `session/closed` 事件，再设置 `closed_at`。关闭后列表与读取 API 均不再展示该会话，事件日志保留以满足审计与回放要求。worker 拒绝运行已关闭会话的排队任务。团队成员可读团队会话，但不可删除其他成员创建的会话。实时 Pub/Sub 只发增量文本；已提交事件只通过 PG/Redis Stream 分发，SSE 客户端按 seq 去重。

---

## 16. Kubernetes 部署

| Workload                      | 副本                         | 说明                                                                                          |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `server` (Deployment)         | HPA 2–20                     | 无状态 API；SSE 长连接无状态亲和要求，滚动升级自然 Drain                                      |
| `agent-worker` (Deployment)   | HPA 0–50                     | 运行 Loop + 工具 + LSP；按队列长度伸缩                                                        |
| `acp-gateway` (Deployment)    | 2                            | stdio 网关（通常作为 sidecar/独立进程被编辑器拉起，云端部署与 server 共用 /acp HTTP binding） |
| `audit-consumer` (Deployment) | 2                            | consumer group 保证 at-least-once，幂等写入                                                   |
| PostgreSQL                    | 云数据库或 StatefulSet + PGO |                                                                                               |
| Redis                         | 云 Redis 或 Sentinel/Cluster |                                                                                               |
| 对象存储                      | S3 / MinIO                   | 附件、spill                                                                                   |
| Ingress                       | NGINX/ALB                    | TLS、SSE 缓冲关闭（`X-Accel-Buffering: no`）、长连接超时调大                                  |

**弹性要点**：worker 缩容前 drain（暂停领取新任务、等待 turn 结束或检查点）；Pod 崩溃 = 会话日志回放恢复（§7）；滚动升级 worker 不影响进行中的会话（事件在 PG，接管即恢复）。

---

## 17. 可观测性与配额

- **会话 token / 费用记账**：每次模型请求追加 contracts 的 `model/usage` 事件，保存唯一 requestId、原始 user event 的 promptId、实际 provider/model、用途（assistant/compaction/subagent）、provider-reported input/output totals 与 uncached/cache-read/cache-write/reasoning 子项。输入总数包含 cache buckets，reasoning 是 output 子集，均不得重复相加。未知数据保持 unavailable；失败/取消时保留已收到的 usage，未报告的请求不伪造零消耗。子 agent 在其独立上下文计量/检查 tenant quota，并把 usage 快照归属父 prompt 写回父会话；不重复写配额计量。
- **费用**：server 与 agent-worker 从固定默认路径 `config/models.yaml` 读取同一份 YAML 价格目录，按精确 `provider/model-id` 匹配；Zod 启动校验，不通过环境变量或 Helm values 重复配置。每模型支持按请求 input total 选择 context tier；保存 currency/version/rates 和精确十进制 cost 快照。Cache write 可分 5m/1h；缺少必要 TTL breakdown 或费率时费用 unavailable。金额用 bigint 定点计算（14 位小数），展示时才舍入；不同币种分别累计，不自动汇率换算。配置变化/切模型不重算历史。配置格式与限制见 [usage-accounting.md](usage-accounting.md)。
- **前端 / 协议**：assistant turn 底部与 session header 显示消费/estimated cost，可展开 token buckets、每模型和 request/rate 明细；requestId 去重确保重放/重连不重复累计，使用 promptId 保持归属，旧日志不补造缺失数据。扩展 wire 事件携带 contracts usage DTO；官方 ACP 通过 `session_info_update._meta["trinity.modelUsage"]` 传递快照，不把累计消费冒充 context occupancy。Inline SSE 同样从事件日志重放、按 seq 发送持久化记录并串行衔接实时 delta；export 包含 usage 快照。`model_usage` 保持租户配额读侧，session_events 是会话费用事实源，不需要改表。

- **OTel**：Loop 每 step 一个 span（模型调用、工具执行、等待审批各自子 span）；指标：token 消耗/成本、工具成功率、审批延迟、队列深度。
- **配额**：`model_usage` 表按租户聚合（小时/天/月 token 与成本），`beforeModelCall` 拦截点实时判定，超限返回友好错误并可申请提额。

---

## 18. 开发路线图

| 阶段              | 内容                                                                                                  | 验收                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **M0 地基**       | monorepo、contracts 包、DI 装配、PG/Redis 基座、CI                                                    | contracts 编译通过；依赖方向 lint gate |
| **M1 最小闭环**   | Loop + LLM Gateway（AI SDK）+ 4 个文件工具 + bash + 内存版会话 + 简化 Web UI（antd Chat）             | 浏览器完成一次多轮编码对话             |
| **M2 企业基座**   | PG 事件溯源、Redis Stream 总线、BullMQ、鉴权/租户/RBAC、审计消费者                                    | 多用户并发；审计可查                   |
| **M3 协议与审批** | ACP HTTP binding（POST+SSE）、acp-gateway（对齐 oc 方法集）、审批流、permission presets、SSE 断点续传 | Zed 接入成功；断线重放无丢包；审批留痕 |
| **M4 智能增强**   | LSP（Python/TS/JSON/YAML）、compaction、subagent、多模态（图片/PDF）                                  | 长会话不爆上下文                       |
| **M5 生产化**     | K8s Helm、HPA、配额、OTel、Sandbox 加固（gVisor 预留）、性能压测                                      | 生产发布 checklist 通过                |
| **M6 扩展**       | Java/Rust LSP、SIEM 外发、API 开放（WebHook/MCP server 化）                                           | —                                      |

---

## 19. 与参考项目的对应关系速查

| 本设计                                | 借鉴来源                                             | 差异点                                                              |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 事件溯源会话 + surfaceOp replace      | dsh `session-persistence-jsonl`、`session/*`         | PG 替代本地 JSONL；加哈希链                                         |
| 值/渲染分离的工具定义                 | dsh `packages/core/tools`                            | 简化：去掉 Cordis 生命周期                                          |
| Loop 外置拦截点                       | dsh waterfall（`agent/*`、`tools/*`）                | 收敛为 4 个显式拦截接口                                             |
| permission presets + fail-closed 审批 | dsh `interaction/user-approval`                      | 审批走 Redis Stream，跨进程                                         |
| compaction / spill / image offload    | dsh `packages/compaction`、`spill`                   | 基本一致                                                            |
| ACP 实现方法集与内部 HTTP SDK 模式    | oc `packages/opencode/src/acp`                       | 同样用官方 SDK；会话存储改为服务端 PG                               |
| 全局事件流扇出多客户端                | oc SSE `/event` + dsh `remote.mux`                   | 放弃 WS 多路复用，改为 ACP over SSE + PG seq 重放，支持多实例       |
| SSE 断点续传                          | SSE 规范原生 `id`/`Last-Event-ID` + dsh 事件溯源 seq | 三层序号对齐（PG seq = Stream offset = SSE id），任意断点可精确重建 |
| ——                                    | ~~dsh Cordis 插件框架~~                              | **放弃**：以显式接口 + DI + 配置组合替代                            |

---

## 20. 参考版本基线（Reference Baseline）

本设计的分析基于以下参考仓库的**具体版本快照**。升级参考版本时，先用 `git log <old>..<new>` 对比，再评估是否吸收新特性。

| 仓库             | 路径                   | Remote                                            | Baseline Commit                            | Tag/描述                        | 快照日期   |
| ---------------- | ---------------------- | ------------------------------------------------- | ------------------------------------------ | ------------------------------- | ---------- |
| deepseek-harness | `ref/deepseek-harness` | `https://github.com/deepseek-ai/deepseek-harness` | `46a7f68b0922371ce7144b668b90e377d8e799f4` | `dsh-v0.1.7-rc.1`               | 2026-09-23 |
| opencode         | `ref/opencode`         | `https://github.com/anomalyco/opencode`           | `009f3799cd6d28cad5a3e1b3902a80f60f93122e` | `github-v1.2.25-455-g009f3799c` | 2026-06-20 |

**升级参考版本的工作流程：**

```bash
# 1. 记录旧基线（即上表中的 commit）
cd ref/<repo> && git fetch origin

# 2. 查看 delta（重点关注 docs/、packages/ 下与本设计 §19 对应的目录）
git log --oneline <baseline>..origin/main
git diff --stat <baseline>..origin/main -- <相关目录>

# 3. 评估：新特性是否值得吸收 → 更新本设计相关章节 + 更新上表 baseline
```

**关注区域对照（diff 时重点看）：**

| 仓库                                                 | 若该目录有更新，检查本设计章节 |
| ---------------------------------------------------- | ------------------------------ |
| dsh `packages/core/session`、`session-persistence-*` | §7 会话持久化                  |
| dsh `packages/core/agent-loop`、`tools`              | §6 Agent Loop、§8 工具系统     |
| dsh `packages/compaction`、`spill`                   | §7 compaction                  |
| dsh `packages/interaction`、`guard`                  | §12 权限与审批                 |
| dsh `packages/acp`                                   | §11 ACP 方法集                 |
| oc `packages/opencode/src/acp`                       | §11 ACP 方法集、HTTP binding   |
| oc `packages/opencode/src/server`                    | §11 SSE 事件流、§14 事件分发   |

---

## 附录 A：术语表

- **Turn / Step**：一轮对话 / 一次模型请求及其工具调用。
- **Surface（表面）**：模型可见的消息序列；compaction 通过 replace 表面区间实现，日志不删。
- **端口/适配器（Port/Adapter）**：模块对外契约 / 契约的具体实现。
- **Fail-Closed**：安全组件失效时默认拒绝。
- **ACP**：Agent Client Protocol（Zed 提出的 JSON-RPC 协议），`@agent-client-protocol/sdk`。
