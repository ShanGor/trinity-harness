# Memory Evolution 实施计划（2026-11-24）

> 状态：**源码机制已实现，默认关闭；真实 provider、部署与语义验收尚未完成**。本文保留分阶段目标与门槛；实际验证见 [memory-evaluation-results.md](memory-evaluation-results.md)。
> 前置阅读：design §21.7/§21.8/§21.9（Persona、记忆自动化、nightly review）、[refactor-as-personal-assistant.md](refactor-as-personal-assistant.md) §6。
> 源码实现不等于生产交付；各阶段验收后须同步更新 [project-progress.md](project-progress.md) 与本文状态。

## 当前实现与边界

- P0：已建立六题合成检索 harness，实际 PostgreSQL ILIKE 基线为 3/6；fake 向量融合为 6/6，仅证明机制。提供显式 opt-in 真实 provider runner。
- P1：独立 `packages/memory`、contracts、SDK embedding gateway、异步 control-worker、持久 claim/retry、pgvector 存储、RRF/90 天半衰期与收据 v3 已接线。未配置/失败保留原词法结果和分页。
- P2：facts/append-only events、owner CAS、来源重审、原子 invalidate+create、历史与 recall type=facts 已实现。Persona 和显式语法沿用基线，不自动注入 facts。
- P3：`memory_propose` 仅在授权 memory consolidation 中提交带来源候选；Suggestions 用户接受/拒绝，接受事务创建 fact。候选绝不自动生效。
- P4：playbook 同样先作为候选，经用户接受后才经 recall type=playbooks 提供；实现事实时间线、替换前后比较、失效、搜索和分层视图。自动注入与自动重组仍是未通过 eval 的实验目标，未实现/未开启。

具体实现选择：

1. 事实/候选/playbook 共享 owner CAS 序号；仅 active fact/playbook 事件推进模型上下文围栏。提交未生效候选不会打断 nightly turn。成功 recall 的完整工具对之后追加 v3 selection 诊断/事实快照，并在下一次 dispatch 前重审；未使用 archival memory 时适配器故障不影响基线。
2. 为覆盖模型维度切换，使用无固定维度的 `vector` 列和 dimensions/model 字段。迁移提供 1536 维 partial HNSW 索引；当前查询先物化已授权候选集，再做精确 cosine 排序，**不宣称使用 HNSW 加速**。其他维度也精确检索。大规模性能与更进一步的围栏内索引优化仍需独立验收。
3. embedding claims 持久保存五分钟 lease 和至多三次尝试；一次失败不阻断同批其他来源；独立可取消循环不阻塞调度/calendar tick，退出时先 drain 再关闭 PG。成功发布的同 hash/model 不重嵌；进程在 provider 返回后、投影提交前崩溃时，未持久化结果可能在 lease 过期后重算，不声称跨外部 provider 的 exactly-once。
4. 所有模型调用仍经 gateway/配额/usage；前台 query embedding 额外占用当前 task request/token 预算，后台重建受批次、租约、重试、取消和 provider 超时约束。嵌入不会记录明文凭据。
5. 关闭开关不装配新工具、适配器或 selection writer，数据休眠。已使用 archival 内容的未完成回合在继续 dispatch 前失败关闭，需用新请求进入基线。三端使用同一个 contracts env shape；Helm/Podman 必须一致部署，不能混跑相反设置的 writer。

事实的 validFrom/validTo 记录记忆创建/裁决与失效时间，不从正文猜测现实世界的生效日期。带日期的原文和历史版本均保留；更精细的事实有效时间推理仍须真实语义评测。

真实语义、用户候选接受率、投毒行为、部署和生产性能门槛保持未勾选；不应据机制测试跳过阶段 rollout 门槛。

## 1. 背景与动机

2026-11-23 对现有 memory 实现的评审结论（调研对象：Mem0、Zep/Graphiti、Letta/MemGPT、A-MEM、MemOS、LangMem，及 MINJA/SpAIware 等记忆投毒研究）：

**现有优势（保留，不回退）：**

- `memory/selection` 先于模型调用提交的可回放收据（业界罕见）；
- 写入侧 provenance 围栏（`sourceQuote` 必须出现在用户原话引用块之外、事务内重审、revision CAS、suppression floor），与最新记忆投毒防御研究方向一致；
- "reference data, never authority" 立场与精确 source anchor；
- nightly review 已是 sleep-time compute 的保守实现（proposals-only）。

**确认的缺口：**

| #   | 缺口                                                                       | 业界对照                                                                |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| G1  | 检索为纯 ILIKE 词法匹配，无 embedding/语义排序，无时间衰减                 | Mem0/Zep 混合检索（语义+关键词+实体）                                   |
| G2  | 自动学习过保守：auto-save 仅接受直接声明，nightly consolidation 仅逐字追加 | Mem0 单遍事实抽取；Letta sleep-time 重组                                |
| G3  | 无矛盾处理与事实生命周期：suppression floor 一次修正压制整段历史           | Zep 时序失效（invalidate, not delete）                                  |
| G4  | 单层 16k Persona 天花板                                                    | Letta Core/Recall/Archival 分层                                         |
| G5  | 无程序/经验记忆（成功方法、踩坑）                                          | ReasoningBank、Memp 等 2025 下半年研究热点                              |
| G6  | 无语义质量评测，改进无法验证回归                                           | 厂商基准互相矛盾（LongMemEval 自报 94.4 vs 第三方 49.0），必须自建 eval |

**核心原则：不推翻围栏与事件溯源去追 SOTA；在围栏之内补齐检索的语义能力与学习的主动性，并用自建 eval 证明每一步改进。**

## 2. 目标与非目标

**目标：**

1. 语义检索：episode 混合检索（向量 ∪ 词法，融合排序），保留全部现有围栏。
2. 事实生命周期：分层记忆（Core Persona + Archival Facts），事实级失效而非整段压制。
3. 提案制学习：nightly consolidation 从"逐字声明"扩展为"带来源的候选事实 + 用户裁决"。
4. 可评测：先于功能建立 memory eval harness，所有检索/抽取改进以其为准。
5. **独立模块、可整体开关**：`MEMORY_EVOLUTION_ENABLED`（默认 false）一键启停，关闭即回到当前基线行为。

**非目标（明确排除）：**

- 团队/跨租户共享记忆（保持现有 out-of-scope 立场）；
- RL 训练记忆策略（Memory-R1 方向）、A-MEM 式 Zettelkasten 链接网络；
- 默认向每个 prompt 自动注入跨会话记忆（保持 model-directed recall 的安全默认；自动注入仅在 Phase 4 经 eval 门控评估）；
- 任何对既有 `session_events`/`memory_events`/`persona_events` 的改写或迁移性删除。

## 3. 必须保留的不变量

实现任何阶段时以下不变量不得削弱：

1. 模型可见的一切可从事件日志回放；`memory/selection` 仍为 commit-before-dispatch 的 append-only 事件。
2. owner/tenant 围栏、policy revision CAS、exclusion/suppression 过滤在所有新旧检索路径上**先于**排序执行。
3. 记忆内容是 reference data；写入路径的 provenance 校验（来源在用户原话中、非引用块、事务内重审）不因新工具而放宽。
4. Fail-closed：embedding 提供者缺失/失败 → 降级词法检索；事实/候选存储失败 → 该能力不可用，不影响基线。
5. 无新插件框架；扩展点仍为 contracts 端口 + DI + composition root 装配。
6. 计量：embedding 与 nightly 抽取调用走既有 `model/usage` 事件与配额，无表外计量。

## 4. 模块与开关设计

### 4.1 独立模块

新增 workspace 包 **`packages/memory`**（Memory Evolution 模块），与既有 Personal Assistant 模块（`packages/core/src/personal-assistant`）的关系是**增强而非替换**：

```
packages/contracts/src/memory-evolution.ts   # 端口与 Zod DTO（唯一定义处）
packages/memory/                             # 纯运行时逻辑：融合排序、衰减、候选准入、评测夹具
packages/db/src/memory-evolution-store.ts    # PG 适配（embedding/fact/candidate/playbook 表）
apps/server|agent-worker|control-worker      # composition root：仅当开关开启时装配
```

- 基线路径（`PersonalContext`、`PgConversationIndex` ILIKE、`persona` 工具、nightly review）**保持原样**，作为关闭开关时的确定行为。
- 开关开启时，composition root 用 Memory Evolution 的端口实现**装饰/替换**对应依赖（如以 `SemanticRecallPort` 适配 `ConversationIndexPort.history` 的调用方），替换关系只存在于装配层，业务模块不 import 新包。
- 遵循包管理约定：不用 `workspace:*`、内部版本引用用 `*`，保持 npm 兼容。

### 4.2 开关与能力协商

| 配置                       | 默认    | 作用域                                 | 说明                                                                                                                                                                       |
| -------------------------- | ------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMORY_EVOLUTION_ENABLED` | `false` | server + agent-worker + control-worker | 模块总开关（用户明确要求的功能开关，属具体需求，非冗余 rollout 控制）。三端必须一致；解析规则同 `CONTEXT_SEGMENTS_ENABLED`（非法值启动即抛错）                             |
| `MEMORY_EMBEDDING_MODEL`   | 未设置  | server + agent-worker + control-worker | `provider/model` 引用，经既有 LLM Gateway 以 `memory-embedding` purpose 解析（Vercel AI SDK `embed`）。**未配置 ≠ 报错**：混合检索降级为词法，其余不依赖向量的阶段功能照常 |

能力协商原则：**配置决定能力**。总开关是用户要求的部署级启停；开关开启后，各子能力由对应配置/适配器是否存在决定，不再加第二层开关。

### 4.3 关闭（turn off）语义

- `MEMORY_EVOLUTION_ENABLED=false`：composition root 不装配新端口；recall 走基线 ILIKE；`memory/selection` 收据回到 v2 字段集；nightly consolidation 回到仅逐字声明模式。
- 已存量的 embeddings / facts / candidates / playbooks **保留但不参与**任何路径（dormant），不删除、不迁移；重新开启后继续可用（embedding 需模型标识匹配，见 §6.1）。
- 新事件字段全部为 additive optional：旧 reader 忽略新字段，新 reader 容忍缺失字段；关闭期间产生的收据与开启期间产生的收据可混合回放。

## 5. Contracts 端口（`memory-evolution.ts`，提案）

```ts
// 嵌入能力（Phase 1）
export interface EmbeddingPort {
  embed(
    texts: string[],
    ctx: { purpose: 'memory-embedding'; signal?: AbortSignal },
  ): Promise<{ vectors: number[][]; model: string; dimensions: number }>;
}

// 混合检索（Phase 1）：在 ConversationIndexPort 既有过滤语义之上提供融合排序
export interface SemanticRecallPort {
  searchEpisodes(req: HybridRecallRequest): Promise<HybridRecallPage>;
  // HybridRecallRequest 保留 owner/scope/minPolicyRevision/recallOnly/date 全部围栏字段，
  // 另加 query 文本；返回项携带 rank 来源标记（vector|lexical|both）供诊断
}

// 分层事实（Phase 2）
export interface FactStorePort {
  activeFacts(owner: OwnerRef, opts?: { kind?: FactKind; limit?: number }): Promise<MemoryFact[]>;
  propose(owner: OwnerRef, fact: NewFact, expected: RevisionFence): Promise<MemoryFact>; // 追加 created 事件
  invalidate(
    owner: OwnerRef,
    factId: string,
    expected: RevisionFence,
    reason: { correctedBy?: string; note?: string },
  ): Promise<void>; // 追加 invalidated 事件
  history(owner: OwnerRef, cursor?: string): Promise<MemoryFactPage>; // 含已失效，供治理 UI
}

// 提案制候选（Phase 3）
export interface MemoryCandidatePort {
  submit(owner: OwnerRef, candidate: CandidateFact, journal: ConsolidationJournal): Promise<string>;
  decide(
    owner: OwnerRef,
    candidateId: string,
    decision: 'accept' | 'reject',
    expected: RevisionFence,
  ): Promise<void>; // accept 同事务提交 FactStorePort.propose
  pending(owner: OwnerRef, cursor?: string): Promise<CandidatePage>;
}

// 程序性记忆（Phase 4）
export interface PlaybookStorePort {
  list(owner: OwnerRef, query?: string): Promise<Playbook[]>;
  upsertFromConsolidation(
    owner: OwnerRef,
    draft: PlaybookDraft,
    journal: ConsolidationJournal,
  ): Promise<void>;
}
```

- `MemoryFact`：`{ factId, kind: 'preference'|'profile'|'project'|'relationship'|'other', text(≤500), sourceEpisodeId?, sourceEventId?, sourceQuote, validFrom, validTo, invalidatedBy?, revision }`。失效为 append-only 事件（`memory_fact_events`），纠正 = 同一事务内 失效旧事实 + 创建新事实（`invalidatedBy` 链接）。
- 所有端口方法在 PG 事务内重审 owner/exclusion/suppression/occurrence（复用 `PgMemoryStore.savePersona` 的审计块模式）；幂等键 + expected revision CAS 同现有惯例。
- `memory/selection` 收据演进到 **v3（additive）**：可选 `recallMode: 'lexical'|'hybrid'`、`facts`、`candidatesDelivered` 等字段；旧 reader 安全忽略。

## 6. 数据模型与迁移（按阶段）

所有迁移走既有流程：改 `packages/db/src/schema.ts` → `pnpm db:generate` → 审查 SQL → `pnpm db:migrate`。设计 §3 已注明 pgvector 为预留项。

| 阶段 | 表                                              | 要点                                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | `episode_embeddings`                            | `(episode_id, embedding_model)` PK；`tenant_id/user_id` 冗余列用于过滤；`vector` 列 + HNSW 索引；`content_sha256`、`policy_revision`、`created_at`。**派生可重建投影**：不在 turn 事务内写入，由 control-worker reconciler 异步补齐（缺则补、哈希变则重嵌），查询侧围栏过滤不变 |
| P2   | `memory_facts` + `memory_fact_events`           | facts 为当前态投影，events 为 append-only 权威流（created/invalidated）；owner advisory lock + CAS 同 persona 惯例                                                                                                                                                              |
| P3   | `memory_candidates` + `memory_candidate_events` | 候选当前态 + append-only 裁决审计；`schedule/occurrence` 来源字段绑定 consolidation journal                                                                                                                                                                                     |
| P4   | `memory_playbooks` + `memory_playbook_events`   | 同上模式                                                                                                                                                                                                                                                                        |

embedding 维度随模型变化：维度与模型标识存入行内，切换 `MEMORY_EMBEDDING_MODEL` 后旧向量自然失配（查询只匹配当前模型），reconciler 按新模型重建；索引按模型分列或重建，迁移文件固定一种实现。

## 7. 分阶段实施

### Phase 0 — 评测先行（eval harness）

**范围**：不改动任何生产行为，先建立测量基线。

- `packages/memory/test/eval/`：确定性夹具——构造合成 owner 时间线（episodes + persona），QA 类别：事实回忆、偏好变更/矛盾、时间定位、中英文改写、负样本（不应召回）。CI 中用 fake embedding/LLM 跑机制正确性。
- `scripts/` 下 opt-in 真实 provider 运行器（参照既有 real-provider 验收门先例），结果记录到 `docs/memory-evaluation-results.md`。
- **基线动作**：先对当前 ILIKE 路径跑一遍，得到基线分数；之后每个阶段必须优于或不劣于基线才允许进入下一阶段。

**验收**：harness 可重复运行；基线分数落档。

### Phase 1 — 混合语义检索（对应缺口 G1）

- 迁移：`episode_embeddings` 表 + pgvector 扩展；control-worker reconciler 异步补嵌（失败有界重试，不影响 turn 路径）。
- `SemanticRecallPort` 实现：向量 top-k ∪ ILIKE top-k → RRF（k=60）融合 → 确定性时间衰减（半衰期可配置常量，纯函数）→ 既有围栏过滤前置。无 embedding 配置时纯词法路径与基线逐字节一致。
- recall 工具调用方经装配层切换；收据记录 `recallMode`。
- **测试**：融合/衰减纯函数单测；db testcontainers（向量写入/过滤/围栏）；fake-LLM loop 集成（收据 v3 回放）；崩溃恢复（reconciler 中断后续跑不重复嵌入——内容哈希幂等）。
- **验收**：eval harness 上 hybrid ≥ lexical（重点：改写、跨语言、时间题）；`pnpm test/lint/typecheck` 全绿；三端开关一致部署后真实 provider 门控通过。
- **回滚**：`MEMORY_EVOLUTION_ENABLED=false` 或仅 unset `MEMORY_EMBEDDING_MODEL`。

### Phase 2 — 分层事实与时序失效（对应 G3、G4）

- 迁移：`memory_facts` / `memory_fact_events`。
- Persona 保持 Core 层（≤16k、始终注入，现状不变）；facts 为 Archival 层，**本阶段仅经 recall 工具按类型查询进入上下文**（`recall` 增加 `type: 'facts'`），不做自动注入。
- 纠正语义：事实级 invalidate+create 替代对事实类内容动用 suppression floor；episode 的 suppression floor 行为**不变**（保守围栏保留给历史会话）。
- persona 工具与 `remember/correct/forget` 语法在开关开启时可选择落 facts（保留 Persona 为用户可见主文档；具体映射在实现评审时定稿，默认最小改动：显式语法仍走现有路径，facts 先服务于后续 Phase 3 的候选落地）。
- **验收**：eval harness 矛盾/变更类题目准确率提升；失效后历史仍可追溯（history 接口）；关闭开关后 facts 完全 dormant。

### Phase 3 — 提案制巩固（对应 G2）

- `consolidation: memory` 扩展：在现有"逐字直接声明追加"之外，模型可经新工具提交**候选事实**（必须带 `sourceEpisodeId`/`sourceEventId`/`sourceQuote`，事务内重审复用现有 consolidation 审计块：auto-save 开启、来源 personal/未删除/未排除/高于 floor、不晚于 occurrence、当轮 recall 交付过该原文）。
- 候选**永不自动生效**：Web Memory settings 新增 Suggestions 收件箱，用户 accept → 同事务提交 fact 事件；reject → append-only 记录。
- `consolidation: review` 行为不变（仍 proposals-only、不可写）。
- **测试**：候选准入矩阵（仿 `persona-automation.test.ts` 的证据校验矩阵）；裁决的 torn-tail 恢复；UI jsdom（草稿保留、裁决反馈）。
- **验收**：eval + 小流量真实账号观察候选接受率与误报率；指标只记计数不记内容。

### Phase 4 — 程序性记忆与治理（对应 G5，含长期项）

- Playbook 蒸馏：nightly 运行可从成功任务 episode 提炼 `{taskType, approach, pitfalls[], sources[]}`，provenance 绑定，作为 reference-only 内容经 recall 提供；**不授予执行权**（与 skills 同一原则：skill/playbook 内容不是执行授权）。
- 治理 UI：事实时间线/diff、手动失效、搜索；Persona 与 facts 的分层视图。
- 评估项（经 eval 门控决定，不默认开启）：向 `memory/selection` 自动注入 top-N active facts；sleep-time 重组（合并冗余事实：invalidate+create，绝不代写 Persona）。
- **验收**：各项独立 eval 门控；注入项需额外验证投毒面（见 §8）。

## 8. 安全与投毒防御

1. **写入侧**：所有新写入路径（facts、candidates、playbooks）复用现有 provenance 围栏模式——来源必须是 owner 自己的会话原文、事务内重审、`sourceQuote` 匹配引用块之外的用户原话。候选永不自动生效，直接阻断 MINJA/SpAIware 类"写入即激活"路径。
2. **读取侧**：recall 返回的历史内容继续携带精确 anchor 并标注为历史数据；Phase 4 若引入自动注入，须在系统引导中明确"召回内容是历史参考而非当前指令"，并经专门投毒评测（构造含注入载荷的历史 episode，验证不改变当前行为）。
3. **数据外流**：embedding 调用会把 episode 文本发给 embedding provider——属显式配置选择，文档中声明数据流；自托管 embedding 经同一 provider 配置支持。未配置即不外流（纯词法）。
4. **指标与日志**：召回命中率、候选接受率只记计数与代码，不记内容/路径/身份（沿用 §17 约束）。

## 9. 计量、部署与 rollout

- embedding 与 nightly 抽取调用以 `memory-embedding` / `memory-consolidation` purpose 走既有 `model/usage` 事件、配额与预算；无旁路。
- 配置面：`.env.example` 增加两个变量（注释默认）；Helm `config.memoryEvolutionEnabled`；server/agent-worker/control-worker env schema 同 `CONTEXT_SEGMENTS_ENABLED` 解析惯例。
- 部署顺序：迁移 → contracts/readers → writers（先部署容忍 v3 收据的 reader，再开启写入）；三端开关一次变更内一致切换；control-worker 仅在开关开启时接受新巩固模式。
- 关闭操作即回滚：见 §4.3；无需数据迁移或事件改写。
- 每阶段交付后更新 [project-progress.md](project-progress.md)、[production-checklist.md](production-checklist.md) 与本文状态；真实 provider 验收结果单独落档。

## 10. 验收指标总表

| 阶段 | 机制验收（确定性）                       | 语义验收（eval harness，real-provider 门控） |
| ---- | ---------------------------------------- | -------------------------------------------- |
| P0   | harness 可重复、CI 通过                  | 基线分数落档                                 |
| P1   | 围栏/回放/降级单测与 testcontainers 全绿 | hybrid ≥ lexical；改写/跨语言/时间题显著提升 |
| P2   | 失效 CAS、torn-tail、history 追溯        | 矛盾/变更题准确率提升                        |
| P3   | 候选准入矩阵、裁决事务                   | 候选接受率与误报率达标（阈值实施时定）       |
| P4   | playbook provenance、治理 UI 测试        | 注入项单独门控 + 投毒评测通过                |

## 11. 参考资料

- Mem0（arXiv:2504.19413，2026-04 token-efficient 算法）；Zep/Graphiti（arXiv:2501.13956，时序知识图）；Letta/MemGPT（arXiv:2310.08560）与 sleep-time compute（arXiv:2504.13171）；A-MEM（arXiv:2502.12110，NeurIPS 2025）；MemOS（arXiv:2507.03724）；ReasoningBank（arXiv:2509.25140）；Memory-R1（arXiv:2508.19828）。
- 安全：MINJA（arXiv:2503.03704，NeurIPS 2025）；AgentPoison（arXiv:2407.12784）；SpAIware 披露（2024-09）。
- 基准可信度：厂商自报与第三方复测差距可达 45 分（LongMemEval），本计划一切以 §Phase 0 自建 harness 为准。
- 内部：design §21.7/§21.8/§21.9；`packages/contracts/src/personal-assistant.ts`；`packages/db/src/personal-assistant-store.ts`。
