# 运行中用户补充：Steering 定义与 Trinity 差距分析

日期：2026-11-17。本文是代码调研与演进建议，不表示功能已实现或架构决策已通过。

调研对象为本机 `../opencode`（HEAD `db1d7b9120`）、`../pi`（HEAD `1f6f319bb`）与当前 Trinity 工作区。引用以本地源码为准，不代表其他版本；未启动这些项目或进行真实模型行为验收。

## 1. 结论

用户描述的能力可以称为 **运行中输入（in-flight input）**，其中直接影响当前工作的部分通常称为 **Steering（运行中引导／纠偏）**。

OpenCode 和 pi 都显式区分两种投递语义：

- **Steering**：用户补充在接下来的执行边界进入模型上下文，影响正在进行的工作。
- **Follow-up / Queue**：先让当前工作自然结束，再处理补充内容。

Trinity Main 已具备可靠的后续请求队列，但尚无明确的“将新输入归入当前任务，并在执行边界消费”的契约。侧 Chat／Work 的标准 UI 还限制忙碌时发送。核心 Gap 是**任务运行期间的输入归属、消费时机与完成一致性**，不只是输入框或消息队列。

## 2. 这种设计具体意味着什么

例如用户先说：“分析 A、B 两个方案并生成报告。”执行中再发送：

| 补充内容                     | 期望语义                                                 |
| ---------------------------- | -------------------------------------------------------- |
| “B 是旧版本，请换成 C。”     | Steering：修正当前比较对象，继续完成报告                 |
| “顺便解释一下你说的兼容性。” | Steering：回答问题，然后继续原任务；除非用户明确改变目标 |
| “报告也请包含成本。”         | Steering：增加当前验收要求                               |
| “这项结束后，再翻译报告。”   | Follow-up：下一项工作                                    |
| “停止，不用继续了。”         | Cancel：停止当前执行，不只是让模型之后读到一句话         |

这里的“加入当前任务”通常不是修改已发送到模型的请求，也不是两个模型同时操作同一会话。它是**协作式调度**：接收新输入，在允许的边界提交／投影，再启动下一次模型请求。

必须区分三个时间点：服务端已接收、运行器已纳入上下文、模型已产生响应。HTTP 成功不等于模型已经看到。已开始的外部副作用也不会因为 Steering 自动撤销。

还要区分三个概念：用户目标（task）、一次运行生命周期（run/turn）、一次模型生成及工具处理（step）。不同项目对 turn 的命名不同，不能直接按类型名对照。

## 3. pi：两条队列与两层循环

源码依据：

- [`agent.ts`](../../pi/packages/agent/src/agent.ts)：`steer()`、`followUp()` 与独立队列；默认队列模式为 `one-at-a-time`。
- [`agent-loop.ts`](../../pi/packages/agent/src/agent-loop.ts)：`runLoop` 的 Steering 检查和外层 Follow-up 检查。
- [`agent-session.ts`](../../pi/packages/coding-agent/src/core/agent-session.ts)：运行中输入要求指定 `streamingBehavior: "steer" | "followUp"`。
- [`README`](../../pi/packages/agent/README.md)：Steering and Follow-up 一节明确说明当前批次工具先完成，再注入 Steering。
- [`agent-loop.test.ts`](../../pi/packages/agent/test/agent-loop.test.ts)：覆盖工具批次、准备请求阶段及队列消费边界。

执行逻辑可简化为：

```text
开始运行 → 检查 Steering
  → 注入待处理消息 → 模型请求 → 执行本次工具批次
  → 检查 Steering
      有工具续跑或 Steering：继续内层循环
      当前工作自然结束：检查 Follow-up
          有：继续运行
          无：结束 agent run
```

关键细节：

1. 当前版本不会因为新 Steering 到达就跳过当前 assistant 消息中尚未完成的工具调用；工具批次先完成。因此不能将其描述为立即抢占工具。
2. `prepareNextTurn` 可能耗时，之后在此前未取得 Steering 时还会再检查；`prepareRequest` 本身不再次消费队列，期间到达的消息等下一正常边界。
3. 队列支持 `all` 和 `one-at-a-time`，控制一次投递全部还是一条。
4. 错误、取消以及 `finishTurn` 的显式结束有独立退出语义，并非所有退出路径都继续清空队列。
5. `Agent` 层的队列是进程内对象。不能据此推断具备 Trinity 所需的 PG 持久恢复、跨 Worker 接管和多租户投递保证；已消费消息的会话保存也不等于待消费队列持久化。

值得借鉴的是清晰的调度语义和可测试边界，而不是照搬内存队列。

## 4. OpenCode：持久 Inbox 与执行协调器

源码依据：

- [`prompt.ts`](../../opencode/packages/core/src/session/prompt.ts)：输入包含 `delivery`，默认 `steer`。
- [`inbox.ts`](../../opencode/packages/core/src/session/inbox.ts)：`steer | queue`、待处理记录、模式切换、`nextPromotable` 和 `promote`。
- [`runner/llm.ts`](../../opencode/packages/core/src/session/runner/llm.ts)：执行边界提升输入并重新加载上下文。
- [`run-coordinator.ts`](../../opencode/packages/core/src/session/run-coordinator.ts)：按 key 串行运行、`pendingWake` 和退出竞态处理。
- [`steer-background.ts`](../../opencode/packages/app/src/session/requests/steer-background.ts)：Steering 配套的阻塞 shell 后台化。

它把输入先保存为待处理 Inbox，再在执行边界提升为模型可见消息。`promote("steer")` 只消费 Steering；`promote("input")` 也允许队列输入，源码明确区分工作中的 step 边界和下一轮输入边界。普通待处理输入可在 queue 与 steer 之间切换；控制类输入还有自己的优先和顺序规则。

协调器负责避免“最后一次检查没有输入，但输入恰好在退出前到达”造成漏唤醒：活跃执行收到 wake 时记录 `pendingWake`，结束前再 drain，必要时创建后继执行。不同会话可并发，同一 key 串行。

另一个体验优化是：接纳 Steering 后，前端配套流程会尝试把阻塞 shell 移到后台，使运行器更早到达下一步。它不等于撤销 shell，也不表示所有工具都可被抢占；该文件也明确不处理本来就在后台运行的子代理。

OpenCode 对 Trinity 更直接的启发，是 **Inbox → 提升 → 上下文可见 → 唤醒／结算** 的完整生命周期。其本地协调器不能直接替代 Trinity 的跨进程 PG 锁和恢复机制。

## 5. Trinity 现状及准确边界

### 5.1 Main 已实现 Follow-up 类排队

[`server.ts`](../apps/server/src/server.ts) 的 `enqueueMain` 先追加 `prompt/queued`，记录内容、身份和权限，再投递任务；队列投递失败保留源事件供持久调度器恢复。

[`ordered-turns.ts`](../packages/core/src/personal-assistant/ordered-turns.ts) 的 `runOrderedPrompts` 在会话运行锁下，按水位顺序选择排队请求；每个请求提升成独立 `message/user` 后 `await execute(...)`，结束后才处理下一个。已结束、丢弃和取消水位均有处理。

所以 Main 忙碌时补充的“B 改成 C”，默认不会作为当前任务的纠正立即生效，而是等待前一请求运行结束。这是可靠的顺序执行，不是当前任务 Steering。

### 5.2 非 Main 的 UI 与 API 不能混为一谈

[`App.tsx`](../apps/web/src/App.tsx) 的发送逻辑对 `busy && session !== mainSessionId` 返回，并将 composer 的 `canQueue` 绑定到 Main。当前标准 UI 的侧 Chat／Work 忙碌时无法采用同样的补充流程。

但服务端非 Main 消息路径仍可直接追加 `message/user` 并提交新的 TurnTask。因此不能写成“整个后端拒绝运行中消息”。这条路径也不能当作已实现 Steering：它没有显式当前任务归属、消费确认或统一的安全边界协议。

尤其 [`agent-loop.ts`](../packages/core/src/loop/agent-loop.ts) 每步会重新加载日志，而 [`to-model-messages.ts`](../packages/core/src/loop/to-model-messages.ts) 将 `message/user` 纳入上下文，并用最近 user 事件推导部分活动状态。绕过 UI 直接追加消息可能影响投影；这是需要专项测试的竞态边界，不能承诺“新消息一定完全不可见”，也不能承诺“可靠合并进当前任务”。

### 5.3 已有连续性机制解决的是其他问题

当前保留原始请求、取消／失败后的未完成目标、上下文回放、任务计划、验证证据和恢复机制，是 Steering 的基础，但不等于运行中增量输入通道。

还应避免命名误判：现有 [`PromptDelivery`](../packages/contracts/src/prompt-delivery.ts) 表示 `phone` 与 `brief/detailed` 的呈现提示，**不是** OpenCode 的输入调度 `delivery`，不应复用这两个不同含义。

## 6. Gap 对照

| 维度         | pi                     | OpenCode                 | Trinity 当前／缺口                            |
| ------------ | ---------------------- | ------------------------ | --------------------------------------------- |
| 输入意图     | steer / followUp       | steer / queue            | Main 后续排队；缺当前任务 Steering 契约       |
| 运行中消费   | 工具批次完成等边界     | runner step 提升 Inbox   | 缺显式接纳与消费步骤                          |
| 输入归属     | 活跃 Agent 队列        | session Inbox 与执行边界 | 主要是新 prompt；缺目标任务及修正来源关联     |
| 待处理持久性 | Agent 层为内存队列     | DB Inbox                 | Main 已持久；缺 Steering 的持久消费／恢复语义 |
| 临近结束到达 | 依赖循环／上层调度边界 | pendingWake 处理结算窗口 | 缺 Steering 与最终结果的原子裁决              |
| 长工具响应   | 等当前批次             | 配套 shell 后台化        | 缺明确延迟说明；不可直接打断或重试副作用      |
| 产品可见性   | 两类队列 API           | Inbox 与投递模式变更     | Main 显示 Queued；缺“待纳入／已纳入当前任务”  |
| 计划与验收   | 依赖模型及上层策略     | 依赖运行器及上层机制     | 现有 plan/evidence 较强，但缺用户补充版本关联 |
| 运行中问答   | 下一模型生成处理       | 下一执行边界处理         | 缺回答插问后继续原目标的明确语义              |

最重要的风险不是模型少看到一句话，而是：**模型看到了新要求，但完成判定、证据有效性、权限和任务 ID 仍在验证旧要求。**

## 7. 建议的最小设计方向（待评审）

### 7.1 先定义行为，再开放输入框

建议运行中提供“补充当前任务”和“完成后处理”两种明确操作。前者用于修正、补充材料和插问；后者沿用后续队列。Stop 保留专门取消通道。

“补充当前任务”默认不取消原目标。明确替换目标时记录更正关系；插问应简短回答后继续，不能把回答插问误判成整个任务结束。若需要在工具未完成时立即回答，应单独设计只读问答通道和结果合并，不能假设 Steering 已提供并发回答。

### 7.2 建立可回放的接纳和消费记录

通过 contracts + Zod 定义独立输入调度语义，不复用手机呈现字段。持久记录稳定输入 ID、目标活动任务、原始内容／附件引用、认证身份与顺序；消费记录绑定任务和上下文版本。事件名称和是否需要额外表在评审时确定。

保持 PG 权威、append-only 日志和会话锁。通知只负责唤醒；重复通知、Redis 丢失和 Worker 重启均从 PG 恢复。先部署兼容读取端，再启用写入端。

不能仅依赖一个“已消费”标志跳过消息：崩溃发生在消费提交与模型请求之间时，必须仍可从事件重建包含该输入的上下文。目标是一次纳入投影和可恢复执行，不承诺外部调用 exactly-once。

### 7.3 在完整工具边界纳入，并围住完成竞态

首版可在当前工具批次完成后、下一模型请求准备前消费补充；不能把用户消息插入尚未闭合的 tool-call/result 对。UI 明示等待工具完成。更快响应长工具需另行设计取消／后台化能力及未知结果处理。

在最终结果提交前，以会话级同步机制核对已接纳输入水位：提交前已有待处理 Steering 时继续当前任务；完成先提交时，新输入按明确策略转后续请求或提示任务已结束，不能静默丢弃。将接纳、最终提交和崩溃恢复放在同一一致性设计中，不只是在内存结束前多查一次队列。

### 7.4 把补充接到现有任务、权限与预算机制

- 保留原始任务身份；将补充作为有来源的新要求／更正，不随意把最新消息替换为唯一目标。
- 约束或验收改变时修订计划与检查；未受影响且依赖仍有效的证据继续保留，不重复已成功的变更。
- 当前用户身份、租户、来源、权限和排除规则在接纳、派发及副作用前继续检查。新自然语言不能作为审批授权。
- 等待审批时到达的纠正需先重新核对待执行操作；旧审批不能给更正后的另一项操作授权。
- 不因每条补充重置累计预算、deadline 或取消状态。预算不足时明确报告未完成内容；更大范围扩展需要独立任务时显式说明。
- 已委派的子任务不能假定自动收到父任务纠正；需明确继续、通知或取消的边界，避免旧目标的子结果推动父任务完成。
- 上下文收据、私有请求快照、缓存段和恢复检查点须包含已接纳版本，避免恢复后丢失纠正。
- UI 显示已接收、待纳入、已纳入及终态。当前任务仍保留一个主完成结果；插问答复的展示要避免伪造一次任务完成。

这些是把现有机制贯通的要求，不建议引入新插件框架、额外模型分类调用或新的通用工作流引擎。

## 8. 实施顺序与验收

建议先实现显式 Steering 的持久契约、边界消费和最终提交水位检查；再统一 Main／侧 Chat／Work 的 UI 与投递状态；最后评估长工具后台化和子任务传播。实施前同步 `design.md`、相关执行设计与仓库规则；本文不修改当前交付状态。

最小验收集：

1. 工具执行中收到“B 改成 C”：完整结束当前工具对，下一请求含原任务与纠正；不会先按 B 宣布完成。
2. 插问回答后继续原任务；Follow-up 在自然结束前不进入当前任务。
3. 多条补充、重复提交、消息乱序有确定消费顺序；稳定 ID 不重复纳入。
4. 最后一次空检查与最终提交之间到达消息：不丢失，明确归入当前或后续任务。
5. 接纳后、消费提交后、模型派发前分别崩溃：重启可重建输入，且不为补账重复副作用。
6. Cancel 与新输入竞争、权限撤销、审批等待、预算用尽均有确定终态和可见反馈。
7. 改变检查只失效相关证据；旧子任务结果、旧缓存和恢复摘要不能覆盖新纠正。
8. Main／Chat／Work、REST／ACP 行为一致；重连、附件、草稿、焦点和流式历史稳定。

用 fake LLM、工具和 ACP 验证事件顺序，用 PG／Worker 恢复测试验证一致性，再做真实模型和浏览器体验验收。机制测试不能证明模型一定理解并完成了补充要求。

## 9. Implementation specification and delivered scope

The following specification supersedes the proposal-only status for the source implementation added on 2026-11-17. Earlier sections describe the baseline used for comparison. Deployment and real-model acceptance remain separate.

### 9.1 User behavior

During a running task, Main, side Chat and Work expose **Supplement current task**. Main also retains **Queue for later**, which starts an independent request after current work. Side Chat/Work do not gain a new follow-up queue in this change. Stop remains a separate control.

A supplement belongs to the original task; it does not append another ordinary `message/user`, allocate a second Loop, reset its budgets, or grant approval. The composer retains failed drafts. Within the mounted composer, retrying unchanged text reuses its input ID. Clients integrating directly should persist their input ID across uncertain transport failures; reload does not promise browser-side retry-ID persistence.

Explicit session prompt denials/approval requirements also apply before application; input content never bypasses them.

The originating request displays each supplement and its state:

| State                         | Meaning                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Waiting for current operation | Durably admitted, awaiting the Loop boundary                                       |
| Included in current task      | Applied to replayable task context; not proof of model understanding or completion |
| Task ended before inclusion   | An error/cancellation ended execution while this input was still pending           |

If completion wins admission, the server returns conflict and preserves the client draft. There is no automatic conversion into another task. An input rejected because the active task has not started can be retried after its durable start event arrives.

### 9.2 REST and ACP contract

The existing authenticated message endpoint accepts an optional strict `steering` object:

```json
{
  "text": "Use C instead of B, and explain compatibility before continuing.",
  "steering": {
    "inputId": "019a0000-0000-7000-8000-000000000001",
    "promptId": "019a0000-0000-7000-8000-000000000002"
  }
}
```

`promptId` is the active original user event ID, not an assistant message ID or a queued request ID. Existing uploaded attachment references can accompany a supplement; the ordinary authorization, upload-reference and input limits remain in force. Steering cannot be combined with retry/amend or phone presentation metadata. `PromptDelivery` retains its existing presentation-only meaning.

A successful response remains HTTP 202 and returns the original prompt ID. Conflicts return HTTP 409 for an ended/stale/cancelled target, a reused ID with different content, or the per-task limit. Validation errors return HTTP 400. Storage failures remain errors; there is no memory-only fallback.

ACP clients use `session/prompt` with the normal prompt blocks and this extension:

```json
{
  "_meta": {
    "trinity.steering": {
      "inputId": "019a0000-0000-7000-8000-000000000001",
      "promptId": "019a0000-0000-7000-8000-000000000002"
    }
  }
}
```

For this explicit extension, the response acknowledges durable admission immediately with `_meta.trinity.steeringAccepted`; it does not wait for the original task to finish. Ordinary ACP prompt behavior remains unchanged. The normal session stream delivers subsequent task progress and completion. Steering wire updates are `session/steering`, also forwarded as ACP session-info metadata under `trinity.steering`.

### 9.3 Durable state and arbitration

Two additive event variants define the lifecycle:

- `steering/accepted`: stable `inputId`, target `promptId`, authenticated actor and original content.
- `steering/applied`: target `promptId` and ordered input IDs included at that boundary.

An accepted input remains available after application; application never deletes or rewrites original content. Pending input is the accepted set minus applied IDs. A maximum of 32 supplements can be admitted per task, including already applied ones. Existing request/body and attachment limits also apply.

Both PostgreSQL and the in-memory test store enforce admission under their append boundary. PostgreSQL uses the existing per-session advisory transaction lock:

1. Reconcile a stable input ID. Exact retries return the original sequence, even after the task ends; changed content or actor/target fails.
2. Require a committed target user message and durable start, with no later user request, target terminal event or applicable cancellation watermark.
3. Enforce the task input limit and append the accepted event.

Successful final answers, task completion metadata and `turn/end` commit together. The store rejects that transaction while pending supplements exist, or if cancellation has already committed. When admission wins, no stale final answer is committed; the Loop returns to the next boundary. When completion wins, later admission conflicts. PostgreSQL episode indexing observes the final answer in the same transaction.

The existing Redis publishing decorator republishes the authoritative stored event on idempotent admission. Inline operation broadcasts admission/application through existing session transport. No additional process, mutable worker inbox, polling timer, schema migration or rollout switch is introduced.

### 9.4 Loop boundaries and side effects

At the next iteration, after the previous tool batch has settled, the Loop checks current execution authorization, commits the applied IDs, reconstructs task input and prepares the next request. Tool call/result pairs stay complete. Applied supplements are rendered as user input with their source IDs and an explicit instruction to preserve the original objective unless replaced.

If a supplement arrives during a model request, that request cannot be changed. After its output finishes, the Loop detects pending input and discards that stale candidate and its unexecuted tool calls. Usage remains recorded. Streamed text may already have been displayed provisionally; only the eventual committed answer is final.

Before a tool starts, pending input returns a no-effect result. Tool context guards also check pending input at internal guarded boundaries, including inherited child guards. This prevents an old approval from automatically starting an operation after a correction has arrived at a checked boundary. Tools already running are not rolled back, killed or retried. A side effect that crosses its last guard before admission may still complete; this is cooperative steering, not transactional cancellation of external systems.

The first version does not background blocking tools. Nor does it promise that a question can be answered before the active tool yields. Child agents do not receive supplements as new delegated instructions; their inherited guard can stop subsequent guarded work, and the parent must reconsider results before continuing.

### 9.5 Plans, evidence and context continuity

When a plan predates applied supplements, verification requires a fresh plan review. Calling `task plan` with unchanged checks can explicitly reaffirm it; that acknowledgment is recorded even though ordinary identical plans remain deduplicated. Existing dependency-based evidence rules preserve unchanged valid receipts. Changed checks, assumptions and intent retain existing fresh-evidence requirements. The mutation preflight also requires a plan current with the applied supplements.

Task intent may cite accepted supplement source IDs belonging to the same task, while still requiring the original request ID. This acknowledges provenance without making the plan an alternative source of user authority.

Applied input is reconstructed after worker recreation and retained across active compaction. Private request snapshots capture the actual rendered model request. Completed dialogue receipts and interrupted-objective receipts retain bounded supplement excerpts with exact original source anchors. Stable-context capacity accounting and pressure trimming include those excerpts. Recall can expand a same-session supplement event subject to the original task's ownership, suppression and exclusion checks; episode request excerpts include supplements for discovery.

This change does not expand Persona write admission: foreground Persona writes still require their existing original-current-message provenance. Stable personal facts stated only in supplements may require a separate ordinary message to save. Historical media delivery also retains existing limitations; bounded supplemental history excerpts are text-only, while original same-session source expansion can return authorized attachment references.

### 9.6 Recovery, budgets and terminal outcomes

| Failure point                            | Recovery behavior                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Before admission commits                 | No accepted input exists; the caller may retry its stable ID                                                |
| After admission, before application      | Original event remains pending for the active task's next recovered iteration                               |
| After application, before model dispatch | Replay reconstructs all applied content; consumed IDs do not hide it                                        |
| During uncertain external effects        | Preserve existing unknown-effect handling; never repeat effects to repair input bookkeeping                 |
| Error, cancellation or deadline          | Existing task terminal semantics win; unprocessed input remains visibly associated with the unfinished task |
| Supplement arrives after completion      | Conflict; draft remains available for a new request                                                         |

Steering does not create an independent recovery scheduler or revive terminal work. Worker job recovery and torn-tail repair retain their existing responsibilities. It also does not reset cumulative request/tool/token/cost budgets, step ceilings or deadlines. Late accepted input may remain unfulfilled if the remaining budget cannot admit another request. A subsequent continuation retains bounded source-backed context and must report limitations honestly.

### 9.7 Rollout and acceptance

Deploy compatible contracts/event readers before enabling the updated server/worker writers, followed by the updated Web client. Existing logs remain readable. No database migration, guest image rebuild or browser runtime change is required. Do not send the new events to an old process whose event schema rejects them.

Verification covers deterministic Loop admission/completion races, stale model candidates, applied-input replay/compaction, REST/ACP admission, PostgreSQL append-lock arbitration, and composer draft/focus/state behavior. Real-provider understanding, long-running external tools, multi-worker crash acceptance and production deployment are separate gates; tests of event order do not certify semantic task completion.

### 9.8 Verification record

Local verification on 2026-11-17: the repository Vitest suite passed 1,782 tests (32 skipped; 184 files passed and 10 skipped), including the PostgreSQL admission/completion race. `pnpm lint`, `pnpm typecheck` and the production Web build passed. Browser inspection used an isolated temporary composer preview through the repository's `agent-browser` skill: desktop/mobile rendering, supplement submission, queue selection and independent Stop were exercised; the preview was removed afterward. This is component-level browser verification, not an authenticated end-to-end deployed task or a real-provider trial. The Web build retains its existing large-chunk advisory.
