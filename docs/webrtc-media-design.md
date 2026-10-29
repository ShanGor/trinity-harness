# WebRTC 媒体面与短期媒体 token 设计

> 状态：**已交付（2026-10-28）：werift 媒体网关适配器（`packages/media-gateway`，G.711 上下行）、浏览器 `RTCPeerConnection` 上行客户端、信令契约/短期 token/Signaling 端点**；已通过进程内真实 RTP/DTLS/SRTP 回环测试、真实 Fun-ASR 上游冒烟（样例音频识别正确）与真实 Qwen3-TTS 下行冒烟（PCM→μ-law RTP→对端接收）。当前电话固定使用 SSE TTS + PCM 播放回复，不选择 RTP 下行。**未交付**：TURN/coturn 公网部署、AEC/barge-in、媒体质量与前端延迟指标、RTP 下行的真实浏览器/设备播放验收。

## 1. 目标与非目标

### 1.1 目标

- 用经鉴权的 WebRTC 媒体通道承载电话的实时麦克风上行与 Assistant 语音下行；ACP POST + SSE 继续承载 prompt、文本、工具、审批业务，音频帧不进入 ACP 文本流，也不逐帧写入 PG。
- 为媒体面引入短期 token（限定用途、受众、有效期、可撤销），长期登录 token 永不进入媒体 URL、日志或客户端配置。
- 支撑后续 AEC / barge-in（§8.3）：WebRTC 提供播放参考信号与采集/播放时钟协同，这是浏览器 WebAudio 播放做不到的。

### 1.2 非目标

- 不做 PSTN/SIP 互通、电话拨号或运营商能力。
- 不改变会话 kind、prompt/ACP 语义、工具与审批授权（媒体 token ≠ 会话所有权/工具权限/审批授权）。
- 不替代已交付的流式 ASR 代理：WebRTC 媒体面落地后，现有 `/api/speech/asr/stream` 路径保留为降级通道。

## 2. 架构

```text
Browser                    Trinity Server                 Upstream
┌────────────┐  信令(WSS)  ┌──────────────┐  代理          ┌────────────┐
│ mic ───────┼─WebRTC 上行─▶│ Media Gateway├──PCM16 16k──▶│ Fun-ASR /ws│
│            │             │ (SFU/peer)   │◆--partial/final│            │
│ speaker ◀──┼─WebRTC 下行─│              │◀─PCM16 24k──│ Qwen3-TTS  │
└────────────┘             └──────────────┘  代理          └────────────┘
        业务面不变：prompt/ACP POST + SSE（含 TTS SSE 降级）
```

组件决策（2026-10-28 选型评审通过）：

- **适配器：werift（纯 TypeScript WebRTC）**。Node 无原生 WebRTC；原候选 mediasoup（原生 C++ worker 子进程，违反仓库“worker 业务逻辑不得派生原始子进程”策略且需供应链 allowlist 变更）与 aiortc（引入第二运行时；本机 Python 3.14 无可用 wheel）在当前环境均不可行。werift 依赖全部为 JS（无原生构建、无子进程），可在仓库测试体系内做进程内真实 RTP/DTLS/SRTP 回环验证。成熟度低于 mediasoup，作为首个适配器已足够；后续如需 SFU/多路能力可再评估。
- **音频编解码：PCMU（G.711 μ-law，8 kHz）唯一声明**。纯 TS 几十行即可解码（`packages/media-gateway/src/g711.ts`），零编解码原生依赖。Opus（opusscript）曾评估并否决：其 encode/decode 缓冲区处理在当前 Node 版本上损坏采样值。μ-law 为电话音质（64 kbit/s），满足 ASR 需要；后续若需高保真下行可再引入可靠 Opus 方案。
- **信令**：复用现有鉴权 WSS（与流式 ASR 代理同一入口风格），消息为 JSON offer/answer/candidate/bye，不引入 SIP。
- **ICE**：适配器以 ICE-LITE controlled 角色运行、host 候选内嵌 answer SDP（非 trickle），满足 LAN/同机部署；TURN 为公网部署的后续项。
- **范围**：适配器覆盖**麦克风上行与 TTS 下行**。下行由信令 `media.speak` 触发：网关经服务端注入的配额化 `MediaTtsFetch` 拉取 Qwen3-TTS PCM（24 kHz），重采样到 8 kHz、μ-law 编码、20 ms 实时帧经 `transceiver.sender.replaceTrack` 注册的本地轨回送浏览器（浏览器 sendrecv m-line；远端轨拒绝 writeRtp，必须用本地轨）；完成时发 `media.tts_ended`（自然播完或 `media.stop_speaking` 打断）。SSE Qwen3-TTS 路径完整保留，并作为当前电话的固定播放路径；RTP 下行待真实浏览器/设备验收后再启用。

## 3. 契约（信令消息）

```ts
// client → server
{ type: 'media.hello', token: '<short-lived media token>' }
{ type: 'media.offer', sdp: string }
{ type: 'media.ice', candidate: RTCIceCandidateInit }
{ type: 'media.speak', text: string }        // TTS downlink（1..5000 字符）
{ type: 'media.stop_speaking' }              // 立即停止当前下行
{ type: 'media.bye' }

// server → client
{ type: 'media.ready', mediaSessionId: string, expiresAt: string }
{ type: 'media.error', code: 'token_expired'|'token_revoked'|'capacity'|'quota'|'invalid_session'|'bad_message'|'not_bound'|'gateway_unavailable'|'tts_unavailable', message: string }
{ type: 'media.answer', sdp: string }
{ type: 'media.ice', candidate: RTCIceCandidateInit }
// ASR 结果（沿信令通道）
{ type: 'media.asr_partial', text: string }
{ type: 'media.asr_final', text: string }
// TTS 下行播完（自然结束或被打断）
{ type: 'media.tts_ended' }
```

- `mediaSessionId` 是服务端媒体会话 ID（区别于本地 `callId`）；通话挂断/刷新即 `media.bye`，服务端立即释放端口与上游连接。
- 信令消息全部经 Zod 校验在边界解析；SDP/candidate 长度设上限（如 64KB）。

## 4. 安全审查

1. **短期 token**：独立签发（不复用登录 token），JWT 或 opaque + Redis，声明 `{sub: userId, tid: tenantId, purpose: 'media', mediaScope: phone-call, exp: ≤10min}`；一次性使用（hello 后绑定会话并作废）；可撤销（Redis 删除即失效）。
2. **授权**：`media.hello` 校验 token + 校验该用户存在进行中的 Chat/Work 会话上下文（服务端记录 call 登记？否——电话状态不入 PG；改为 hello 时由客户端提交 `sessionId`，服务端校验该会话归属用户且存活）。
3. **fail-closed**：token 缺失/过期/撤销/签名不符一律拒绝；上游不可用拒绝建连；媒体网关崩溃客户端回落 SSE 批量路径。
4. **不可信输入**：远端 SDP/candidate 当作不可信输入解析（不用 `eval`/JSON5）；ICE 候选仅 relay/srflx，过滤 host 内网地址之外的异常目标。
5. ** egress**：媒体网关对上游只访问配置的 `SPEECH_ASR_URL`/`SPEECH_TTS_URL`；不引入任意出网。
6. **审计**：token 签发/撤销、媒体会话建连/断开写审计（不含音频内容、SDP 以外的负载）。
7. **日志**：SDP、candidate、token 全文不入日志（SDP 可截断记录指纹）；指标不带用户/会话标识。

## 5. 部署拓扑

- 媒体网关独立部署单元（独立进程/容器），与 server 同机或邻近网络以降低媒体延迟；信令经 server 反代 `/api/media/signaling`（WSS，复用现有鉴权 hook）。
- TURN：LAN/单节点开发不需要；公网部署需要 coturn（STUN+TURN，账号动态生成、与媒体 token 同生命周期）。NAT 穿透失败必须可检测并回落 SSE 路径，界面不得卡在“连接中”。
- 容量：每网关实例并发媒体会话上限（如 32），超出返回 `media.error: capacity`；配额扩展 `concurrentMediaSessions`（租户级）入 `tenantQuotaSchema`，与 §8.4 同一计量器。
- 时钟/采样：WebRTC 音频统一 Opus 48k；网关重采样 16k 喂 ASR、TTS 24k→48k 上桥。

## 6. 验收门槛（实施前冻结；状态标注于 §7）

1. ~~信令契约测试（fake TURN/ICE）~~ **已交付**：offer/answer/candidate/bye 全序列、token 过期/撤销/容量拒绝（`apps/server/test/media-signaling.test.ts`）。
2. ~~端到端媒体测试~~ **已交付（进程内）**：werift 对端经真实 RTP/DTLS/SRTP 收发 PCMU——上行喂入 Fun-ASR、下行收到 TTS μ-law 帧（`packages/media-gateway/test/werift-gateway.test.ts`）＋真实 Fun-ASR/Qwen3-TTS 冒烟。**浏览器内 E2E 仍属设备验收项**。
3. AEC/barge-in 专项（§8.3）：播放参考信号注入、模拟回声下不误打断、真实语音插话触发受控打断（停止播放+取消当前句，不取消 Agent）——未交付（依赖媒体下行与真实设备）。
4. ~~回落~~ **已交付**：`/api/media/*` 未配置 501；客户端建立失败自动降级流式 ASR + SSE TTS；通话中媒体失败进入可重连错误态。
5. 配额/指标：`concurrentMediaSessions` 拒绝路径 **已交付**；WebRTC 建连时长、丢包/抖动、barge-in 检出与停止延迟、误打断率指标——未交付。
6. ~~安全评审~~ **已交付（契约层）**：token 生命周期、SDP 注入（m-line fail-closed 校验）、日志红线已在 §4 固化；TURN 凭证安全随 TURN 部署复审。

## 7. 当前状态

**已交付（2026-10-28）：**

- 信令消息契约（`packages/contracts/src/media.ts`，Zod 判别联合，双向）与 `MediaGatewayPort` / `MediaTokenPort` 端口。
- `POST /api/media/token`：鉴权 + 会话归属校验（`authorizeSession`）后签发短期 token；媒体平面未配置时 501；无认证部署 401（fail-closed）。
- `RedisMediaTokens`（`apps/server/src/media-token.ts`）：opaque token（非 JWT）、Redis `SET EX` + `GETDEL` 一次性消费、可撤销、后端错误 fail-closed。
- `GET /api/media/signaling`（WebSocket）：升级时用普通登录 token 鉴权（`?token=`，与 SSE/ASR 代理同规则）；`media.hello` 一次性消费媒体 token 并校验调用者与 `sessionId` 绑定；`media.offer`/`media.ice` 中继到网关端口；网关 `asr_*` 事件以 `media.asr_*` 线上格式回传（剥离服务端会话 ID）；`bye`/断开释放网关会话与 `concurrentMediaSessions` 配额租约。
- **werift 媒体网关适配器**（`packages/media-gateway`）：`WeriftMediaGateway implements MediaGatewayPort`——ICE-LITE/非 trickle answer、G.711 μ-law 纯 TS 解码、8 kHz→16 kHz 重采样、PCM 帧喂 Fun-ASR `/ws`（`FunAsrPipe`）、`asr_*` 事件上行；`allocate` 在上游不可用时 fail-closed。
- **浏览器客户端**（`apps/web/src/media-client.ts`）：`RTCPeerConnection` + 一次性 token + 信令握手（hello→offer→answer→ICE trickle）；`media.asr_partial/final` 驱动与流式 ASR 完全相同的字幕/提交/fencing 语义。媒体客户端仍保留下行协议表面，但电话控制器只使用麦克风上行，回复固定走 SSE TTS + PCM 播放，避免 RTP `tts_ended` 与浏览器实际可听输出不一致。通话控制器按 **WebRTC → 流式 ASR → 批量录音** 顺序自动降级，三种识别模式共用同一 SSE TTS 播放路径。
- 租户配额：`concurrentMediaSessions` 入 `tenantQuotaSchema`，`SpeechQuotaMeter` 新增 `media_session` 租约；配额配置不可读 → `media.error: quota`，超限 → `media.error: capacity`。
- 指标：`trinity.media.{connections,sessions,tokens_issued,errors,session_seconds}`（bounded 属性）。
- 测试：token 生命周期、信令全流程、配额容量、网关分配失败 fail-closed、未配置 501、G.711 编解码、**进程内真实 RTP/DTLS/SRTP 回环**（werift 对端发送 PCMU → 网关 → 假上游断言 PCM16 16 kHz 内容）、**真实 Fun-ASR 上游冒烟**（样例音频识别出正确文本）。服务器在配置 `SPEECH_ASR_URL` + Redis 时自动组合适配器（`main.ts`）。

**未交付：**

- TURN/coturn 公网部署（当前 ICE-LITE host 候选仅覆盖 LAN/同机）。
- AEC/barge-in（§8.3）：媒体面上下行虽已打通，但浏览器侧回声消除效果、播放参考信号与真实插话检出仍需真实设备验收；打断当前为显式点按（与第一阶段一致）。
- 前端延迟类指标（prompt→首音）与 WebRTC 媒体质量指标（建连时长/丢包/抖动）。
