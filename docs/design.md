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

| # | 原则 | 说明 |
|---|------|------|
| P1 | **接口即契约** | 每个模块对外只暴露 TypeScript interface（端口），依赖注入（DI）组装实现。禁止模块间直接 import 具体实现。 |
| P2 | **事件溯源的会话日志** | 会话状态 = 事件日志的投影（借鉴 dsh）。模型可见的一切必须可从日志重放，审计因此免费获得。 |
| P3 | **拦截点外置** | Agent Loop 保持精简；权限、审计、限流、脱敏都以"管线拦截器/装饰器"挂在 Loop 外（借鉴 dsh 的 waterfall 拦截点）。 |
| P4 | **工具的值/渲染分离** | 工具执行返回规范化 JSON 值，渲染成模型可读内容由独立层负责（借鉴 dsh）。 |
| P5 | **无状态服务，有状态归数据层** | 计算服务（API、Agent Worker）无本地状态，状态全部落 PostgreSQL / Redis，K8s 上可自由伸缩。 |
| P6 | **全局事件总线** | Redis Stream 作为唯一的事件分发机制，任何模块通过订阅流获得实时事件，支持多实例扇出。 |
| P7 | **失败关闭（Fail-Closed）** | 权限、审批、密钥等安全环节，组件缺失或超时一律拒绝。 |

> 关于"不要 Plugin"：dsh 用 Cordis 插件框架同时承担了三种职责——DI 装配、部署组合、第三方扩展——这是我们**明确要避免**的。本设计中这三者分离：
> - **模块装配** = DI 容器 + 显式接口（编译期类型安全）；
> - **部署组合** = 配置文件声明启用哪些模块（等价于 dsh 的 profile/bundle，但只是配置，不是代码扩展机制）；
> - **第三方扩展** = 仅保留一个**狭义的、沙箱化的**外部工具接入通道（MCP），不开放服务端代码级扩展。

---

## 3. 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 语言 | TypeScript（Node.js 22+，ESM） | 全栈同构；AI SDK 生态最成熟 |
| AI 抽象 | **Vercel AI SDK**（`ai` + provider 包） | 统一 `generateText/streamText` 接口，天然支持工具调用、多模态、流式 |
| 前端 | **React 19** + **Ant Design 5** | antd 提供企业级组件（表格、审批流、表单），省去大量开发 |
| 前端构建 | Vite | |
| 后端框架 | Fastify（HTTP + WebSocket） | 轻量、高性能、schema-first |
| 数据库 | **PostgreSQL 16+** | 会话事件、用户、审计、配额（pgvector 预留） |
| 缓存/事件 | **Redis 7+**（Stream + Pub/Sub + 分布式锁） | Stream 做事件总线，Pub/Sub 做低延迟信号 |
| 任务队列 | BullMQ（基于 Redis） | Agent 任务异步调度、重试 |
| ORM | Drizzle | 类型安全、轻量 |
| RPC/事件 Schema | Zod（单 schema 库，前后端共享） | 与 AI SDK、Fastify 天然配合 |
| K8s | 原生 manifests（或 Helm） | |
| 可观测性 | OpenTelemetry + Prometheus | |
| LSP | `vscode-languageserver-protocol` 客户端库 | |

Monorepo 采用 **pnpm workspaces**，分层目录：

```
trinity-harness/
├── apps/
│   ├── web/                    # React 19 + antd 前端
│   ├── server/                 # API 服务（Fastify，无状态）
│   ├── agent-worker/           # Agent 执行进程（Loop 所在）
│   └── acp-gateway/            # ACP 协议网关（stdio ↔ 内部 API）
├── packages/
│   ├── contracts/              # ★ 全局接口契约（所有模块边界的唯一定义处）
│   ├── core/                   # 模块实现：loop、tools、session、llm…
│   ├── modules/                # 各功能模块实现（见 §5）
│   └── shared/                 # 工具函数、zod schema、事件类型
├── deploy/
│   └── k8s/                    # K8s manifests / Helm
└── docs/                       # 设计文档
```

**`packages/contracts` 是全设计的核心**：所有模块接口（端口）、事件类型、DTO schema 集中定义，模块之间只允许依赖它。

---

## 4. 总体架构

```
                        ┌──────────────────────────────────────────────┐
                        │                   K8s Cluster                 │
                        │                                              │
 Browser (React+antd)   │   ┌───────────┐   ┌───────────────────────┐  │
        ▲  ▲            │   │  Ingress  │──▶│  server (API, ×N)     │  │
        │  │ WSS/SSE    │   └───────────┘   │  - REST / WS / SSE    │  │
        │  └────────────│───────────▶       │  - ACP WebSocket      │  │
        └───────────────│───────────────────│  - 鉴权/租户路由       │  │
                        │                   └───┬───────────┬───────┘  │
 Zed / 编辑器 (ACP stdio)│                       │           │          │
        └───────────────│────────▶ ┌────────────┴──┐   ┌────┴───────┐  │
                        │          │ acp-gateway   │   │  Redis     │  │
                        │          │ (stdio↔WS)    │   │  - Streams │  │
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

1. 浏览器通过 Ingress 建立 WSS/SSE 连接 → `server` 鉴权、路由。
2. 用户发送 prompt → `server` 写 `session_events`（user_message）→ 向 BullMQ 投递任务。
3. `agent-worker` 领取任务，从 PG 加载会话事件日志，重放投影出消息上下文。
4. Loop 运行（LLM 流式调用 + 工具执行），每产生一个事件立即 append 到 PG 并发布到 Redis Stream。
5. `server` 订阅对应流，将事件实时推送给浏览器；其他订阅者（审计、配额、ACP 客户端）并行消费。

---

## 5. 模块划分与接口（核心章节）

### 5.1 模块总览

| 模块 | 职责 | 关键依赖（仅 contracts） |
|------|------|--------------------------|
| `LLM Gateway` | 统一模型访问：流式、工具调用、多模态、重试、计量 | `ModelProvider` |
| `Agent Loop` | turn/step 驱动、工具调度、并发控制、取消 | `ToolRegistry`、`SessionStore`、`LLMPort`、`ApprovalPort` |
| `Tool Runtime` | 工具注册、参数校验、执行管线（pre/execute/post） | `SandboxPort` |
| `Session Core` | 事件溯源日志、消息投影、压缩（compaction）、fork | `EventBus` |
| `Context Manager` | 上下文压力检测、压缩、溢出文件化（spill） | `LLMPort`、`SessionStore` |
| `LSP Service` | 语言服务接入：诊断、符号、跳转、格式化 | （对 Loop 暴露为工具） |
| `Permission & Approval` | 工具审批、策略判定、审批持久化 | `EventBus` |
| `Audit` | 全链路审计事件采集与查询 | `EventBus` |
| `Multimodal` | 图片/文档解析、附件存储、内容分块 | `BlobStore` |
| `Sandbox` | 命令执行与文件系统隔离（先容器内，预留 gVisor/Firecracker） | — |
| `Identity & Tenant` | 用户、租户、RBAC、配额 | PostgreSQL |
| `Event Bus` | Redis Stream 封装：发布、消费组、重放 | Redis |
| `API Server` | REST/WS/SSE 网关、会话控制、配置 | 以上全部（通过 DI） |
| `ACP Adapter` | ACP 协议 ↔ 内部服务的翻译层 | `API Server`（内部 SDK） |

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

| 机制 | 设计 |
|------|------|
| **工具并发** | 按 `concurrency` 分类，滚动并发池（默认上限可配）；`tool/call` 与 `tool/result` 严格按模型输出顺序提交日志，保证重放确定性。 |
| **取消** | AbortSignal 贯穿 LLM 流与工具执行；中止时补写合成 `ABORTED` 结果事件，日志不残缺。 |
| **拦截点（Loop 外置）** | `beforeStep` / `beforeModelCall` / `beforeToolExecute` / `afterToolExecute` 四个拦截点，权限、审计、脱敏、限流均实现为拦截器注册，Loop 本体零侵入。 |
| **LLM 适配** | 由 `LLM Gateway` 内部用 Vercel AI SDK 的 provider 机制实现 `LLMPort`；重试、fallback 模型、token 计量在此层完成。 |

---

## 7. 会话持久化：事件溯源

直接借鉴 dsh 的成熟设计，但持久化到 PostgreSQL 而非本地 JSONL：

- **`session_events` 表**：`(session_id, seq, event_type, payload_jsonb, actor, created_at, prev_hash)`，append-only，`seq` 单调；`prev_hash` 形成哈希链，防篡改（审计要求）。
- **表面投影（projection）**：模型可见消息 = 事件的纯函数投影；compaction **只追加日志事件并 replace 表面区间**，历史永不删除（对应 dsh 的 `surfaceOp: replace`）。
- **Fork**：复制事件前缀 + `session/forked` 标记，O(1) 元数据操作 + 逻辑视图。
- **回放**：worker 崩溃恢复时，从上次 `turn/end` 之后截断的尾部自动合成关闭事件（借鉴 dsh 的 torn-tail 修复）。
- **Compaction**：LLM 生成摘要替换表面区间；摘要边界吸附在 tool call/result 配对处；图像转储（image offload）、大结果 spill 到对象存储仅留引用（借鉴 dsh `spill/`）。

---

## 8. 工具系统

首批内置工具（优先级从高到低）：

| 工具 | 说明 |
|------|------|
| `bash` | 经 Sandbox 执行 shell，支持持久会话、沙箱升级需审批 |
| `read_file` / `write_file` / `edit_file` | edit 采用 str-replace 语义（强制模型先读再改，减少误改） |
| `glob` / `grep` | 代码检索（rg 后端） |
| `web_search` / `web_fetch` | 联网能力（可配置关闭） |
| `todo` | 任务规划 |
| `lsp_*` | `lsp_diagnostics` / `lsp_symbols` / `lsp_hover` / `lsp_rename` |
| `ask_user` | 向用户提问（阻塞 turn 直至回复） |
| `subagent` | 派生子 Agent（独立上下文，结果回收） |

工具实现遵循 §5.2 的 `ToolDefinition`：execute 返回规范化 JSON 值，`render` 负责生成模型可见内容——**测试与 UI 展示都可复用同一渲染层**。

---

## 9. LSP 集成

- 技术：`vscode-languageserver-protocol`，每个工作区根目录惰性启动一套 language server（Python→pyright、TS/JS→typescript-language-server、JSON/YAML→vscode-json-languageserver/yaml-language-server；二期加 Java（jdtls）、Rust（rust-analyzer））。
- **进程模型**：agent-worker Pod 内运行 LSP 进程池，按 workspace 缓存；worker 缩容时优雅 shutdown。
- 对 Loop 的暴露：LSP 能力通过 `lsp_*` 工具供模型主动调用；同时 **diagnostics 作为自动上下文注入**——在 `beforeStep` 拦截点收集当前会话涉及文件的诊断信息，注入 system prompt 区域（带缓存与失效策略）。
- 伸缩考虑：LSP 进程是 worker 内存大头，配置 per-pod 上限 + LRU 回收。

---

## 10. 多模态支持

| 能力 | 设计 |
|------|------|
| 输入 | 前端上传图片/PDF → Multimodal 模块存对象存储（S3/MinIO）→ 生成 `file` part（AI SDK 标准格式）注入消息；PDF 走文本抽取 + 页图双通道 |
| 模型侧 | `LLMPort` 消息直接携带 AI SDK 的 `ImagePart`/`FilePart`，由 Vercel AI SDK 按 provider 能力编码 |
| 输出 | 图表生成（mermaid/代码）前端渲染；图像生成工具预留 |
| 上下文成本 | 图片超过阈值时压缩/转储，引用代替内联（offload） |
| 会话中的历史附件 | 事件日志只存引用（URI + 摘要），内容在对象存储 |

---

## 11. 前后端协议

### 11.1 Web 原生协议

- **传输**：REST（控制面，如创建会话、审批回复）+ **WebSocket**（事件面，多路复用逻辑流，借鉴 dsh 的 `remote.mux`）。
- **事件源唯一**：服务端所有状态变化都来自事件日志/Redis Stream，WS 只做转发，不做第二事实源。
- **消息格式**（zod schema 前后端共享）：

```ts
// 服务端 → 客户端
type ServerEvent =
  | { type: 'session.update'; sessionId: string; update: AssistantDelta | ToolCallUpdate | ... }
  | { type: 'approval.request'; approvalId: string; toolCall: {...}; options: PermissionOption[] }
  | { type: 'usage.update'; tokens: {...}; cost: number }
// 客户端 → 服务端
type ClientCommand =
  | { type: 'session.prompt'; sessionId: string; content: ContentBlock[] }
  | { type: 'session.cancel'; sessionId: string }
  | { type: 'approval.reply'; approvalId: string; outcome: ... }
```

### 11.2 ACP 支持（借鉴 opencode）

- 独立组件 `acp-gateway`：`stdio ↔ 内部服务` 的翻译层，使用官方 **`@agent-client-protocol/sdk`**（NDJSON over stdio），与 oc 相同思路。
- 内部通信：gateway 启动/连接内部 server，通过内部 HTTP SDK + 全局事件流（SSE/WS 订阅）工作——**ACP 会话与 Web 会话 1:1 映射到同一 session 存储**，用户在浏览器和 Zed 里看到的是同一会话。
- 实现的方法集（对齐 oc 的覆盖面）：
  - Agent 侧：`initialize` / `authenticate` / `session/new` / `session/load` / `session/list` / `session/resume` / `session/close` / `session/unstable_fork` / `session/set_config_option` / `session/set_mode` / `session/prompt` / `session/cancel`
  - Client 侧：`session/update`（消息/思考 chunk、tool_call 状态机、usage）、`session/request_permission`（审批走此通道，映射到内部 ApprovalPort）、`fs/write_text_file`（edit 类权限由客户端自行落盘）
- Web 场景下 ACP 也可跑在 WebSocket transport 上，供未来的第三方 Web 客户端接入。

---

## 12. 安全、权限与审批

1. **工具执行策略**（每会话可配，预置模板借鉴 dsh 的 permission-presets）：
   - `workspace-write + ask`（默认）：工作区内写自由，危险命令需审批；
   - `read-only`：只读；
   - `danger-full-access + never`（CI 场景，禁用审批）。
2. **审批流**：工具命中策略 → `ApprovalPort.request` → 事件发布到 Redis Stream → API Server 推送到前端对话框（或 ACP `session/request_permission`）→ 结果写回事件日志（**审批请求与结果均留痕**）。无应答器时 fail-closed。
3. **Sandbox**：v1 在容器内运行（K8s Pod 内嵌套隔离 + 文件系统只读挂载 + 网络策略）；预留接口切换 gVisor / Firecracker microVM；越权操作必须经审批后升级。
4. **RBAC**：租户 → 角色（admin/developer/viewer）→ 会话与工具策略；密钥（模型 API Key 等）由服务端统一托管（K8s Secret + 信封加密），**永不下发前端**。
5. **输入输出安全**：prompt 注入提示、工具结果大小上限、出站网络 egress 白名单。

---

## 13. 审计（企业级一等公民）

- **审计 = 事件日志的投影**。所有敏感面（登录、会话创建、prompt、工具调用与参数、审批请求/结果、策略变更、配置变更、数据导出）都以 `audit/*` 事件进入同一事件溯源体系，哈希链保证不可篡改（§7）。
- **独立审计消费者**：一个单独的 K8s Deployment 以 Redis Stream consumer-group 消费 `audit` 流，写入 `audit_log` 表（列式友好字段：who/tenant/what/when/result/ip/session），支持企业 SIEM 外发（Webhook/Kafka，预留）。
- **留存与合规**：可配置留存策略（热 PG + 冷对象存储），支持按租户导出、WORM 模式预留。
- **查询**：前端 antd 表格 + 过滤器（时间/用户/会话/工具/结果），管理员角色可见。

---

## 14. Redis Stream 全局事件分发

| 用途 | 设计 |
|------|------|
| 事件总线 | 每会话一个 Stream（`sess:{id}`）+ 全局流（`global`）；事件 append 后由 worker `XADD`，所有订阅方（API Server、审计、配额、其他 worker）以 consumer group 消费 |
| 扇出 | API Server 每个 WS 连接订阅对应会话流，实现多浏览器 tab / ACP 客户端同屏同步 |
| 重放 | 新订阅者以 `XREADGROUP` 从指定 offset 消费历史；断线重连用 `last-seq` 增量补发 |
| 容量 | 每流设 `MAXLEN ~ N`（近似截断），**事实源始终是 PG**，Redis 只是分发层，截断不丢数据 |
| 其他 Redis 用途 | Pub/Sub：低延迟信号（中断、心跳）；分布式锁：会话独占执行（同一会话同时只有一个 worker 运行 Loop）；BullMQ：任务队列 |

---

## 15. 数据库概要（PostgreSQL）

```
users(id, email, password_hash, role, created_at)
tenants(id, name, quota_jsonb)
sessions(id, tenant_id, user_id, title, workspace_uri, policy, forked_from, created_at, closed_at)
session_events(session_id, seq, type, payload jsonb, actor, prev_hash, created_at)  -- append-only
audit_log(id, tenant_id, user_id, session_id, action, target, result, ip, detail jsonb, created_at)
approvals(id, session_id, tool_call_id, request jsonb, outcome, decided_by, created_at, decided_at)
model_usage(id, tenant_id, session_id, model, input_tokens, output_tokens, cost, created_at)
api_keys / credentials(id, tenant_id, kind, ciphertext, created_at)
```

---

## 16. Kubernetes 部署

| Workload | 副本 | 说明 |
|----------|------|------|
| `server` (Deployment) | HPA 2–20 | 无状态 API；WS 连接亲和（可选） |
| `agent-worker` (Deployment) | HPA 0–50 | 运行 Loop + 工具 + LSP；按队列长度伸缩 |
| `acp-gateway` (Deployment) | 2 | stdio 网关（通常作为 sidecar/独立进程被编辑器拉起，云端部署提供 WS 模式） |
| `audit-consumer` (Deployment) | 2 | consumer group 保证 at-least-once，幂等写入 |
| PostgreSQL | 云数据库或 StatefulSet + PGO | |
| Redis | 云 Redis 或 Sentinel/Cluster | |
| 对象存储 | S3 / MinIO | 附件、spill |
| Ingress | NGINX/ALB | TLS、WS upgrade |

**弹性要点**：worker 缩容前 drain（暂停领取新任务、等待 turn 结束或检查点）；Pod 崩溃 = 会话日志回放恢复（§7）；滚动升级 worker 不影响进行中的会话（事件在 PG，接管即恢复）。

---

## 17. 可观测性与配额

- **OTel**：Loop 每 step 一个 span（模型调用、工具执行、等待审批各自子 span）；指标：token 消耗/成本、工具成功率、审批延迟、队列深度。
- **配额**：`model_usage` 表按租户聚合（小时/天/月 token 与成本），`beforeModelCall` 拦截点实时判定，超限返回友好错误并可申请提额。

---

## 18. 开发路线图

| 阶段 | 内容 | 验收 |
|------|------|------|
| **M0 地基** | monorepo、contracts 包、DI 装配、PG/Redis 基座、CI | contracts 编译通过；依赖方向 lint  gate |
| **M1 最小闭环** | Loop + LLM Gateway（AI SDK）+ 4 个文件工具 + bash + 内存版会话 + 简化 Web UI（antd Chat） | 浏览器完成一次多轮编码对话 |
| **M2 企业基座** | PG 事件溯源、Redis Stream 总线、BullMQ、鉴权/租户/RBAC、审计消费者 | 多用户并发；审计可查 |
| **M3 协议与审批** | ACP gateway（对齐 oc 方法集）、审批流、permission presets、WS 多路复用 | Zed 接入成功；审批留痕 |
| **M4 智能增强** | LSP（Python/TS/JSON/YAML）、compaction、subagent、多模态（图片/PDF） | 长会话不爆上下文 |
| **M5 生产化** | K8s Helm、HPA、配额、OTel、Sandbox 加固（gVisor 预留）、性能压测 | 生产发布 checklist 通过 |
| **M6 扩展** | Java/Rust LSP、SIEM 外发、API 开放（WebHook/MCP server 化） | — |

---

## 19. 与参考项目的对应关系速查

| 本设计 | 借鉴来源 | 差异点 |
|--------|----------|--------|
| 事件溯源会话 + surfaceOp replace | dsh `session-persistence-jsonl`、`session/*` | PG 替代本地 JSONL；加哈希链 |
| 值/渲染分离的工具定义 | dsh `packages/core/tools` | 简化：去掉 Cordis 生命周期 |
| Loop 外置拦截点 | dsh waterfall（`agent/*`、`tools/*`） | 收敛为 4 个显式拦截接口 |
| permission presets + fail-closed 审批 | dsh `interaction/user-approval` | 审批走 Redis Stream，跨进程 |
| compaction / spill / image offload | dsh `packages/compaction`、`spill` | 基本一致 |
| ACP 实现方法集与内部 HTTP SDK 模式 | oc `packages/opencode/src/acp` | 同样用官方 SDK；会话存储改为服务端 PG |
| 全局事件流扇出多客户端 | oc SSE `/event` + dsh `remote.mux` | 升级为 Redis Stream，支持多实例 |
| —— | ~~dsh Cordis 插件框架~~ | **放弃**：以显式接口 + DI + 配置组合替代 |

---

## 附录 A：术语表

- **Turn / Step**：一轮对话 / 一次模型请求及其工具调用。
- **Surface（表面）**：模型可见的消息序列；compaction 通过 replace 表面区间实现，日志不删。
- **端口/适配器（Port/Adapter）**：模块对外契约 / 契约的具体实现。
- **Fail-Closed**：安全组件失效时默认拒绝。
- **ACP**：Agent Client Protocol（Zed 提出的 JSON-RPC 协议），`@agent-client-protocol/sdk`。
