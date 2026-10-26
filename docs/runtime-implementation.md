# Personal runtime：首批实现与部署

日期：2026-10-26。控制面继续由 K8s 托管；专用 KVM 宿主上的 Node Agent 独立部署。目标架构仍见 [整体方案](personal-assistant-runtime-architecture.md)。

## 已实现的路径

| 路径                            | 实现边界                                                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser activity → Open browser | 会话响应中显示浏览器活动；managed runtime 支持截图观看和显式 Start / Take control、坐标点击 / 拖动、滚动、键盘 / 粘贴与地址导航。结构化输入与 Agent 在同一 PG 锁下互斥；trusted CDP 保持只读。                                                                   |
| Preview 授权与隐私              | `/api/sessions/:id/browser-preview` 只允许个人 session owner，租户 admin 和 team 可见性不授予观看私有登录态的权限。捕获前后检查 owner / binding / document / sensitive surface；错误、busy、隐私拒绝会清除旧画面。图片仅临时传给用户，不产生模型证据或工具调用。 |
| 定时任务                        | PG schedule、once / daily + weekday、IANA timezone、future instant、暂停 / 恢复、operation 去重。Web 首批提供 daily 创建；HTTP schema 同时支持 once。无复杂 cron 字符串或 shell schedule。                                                                       |
| 执行与恢复                      | `apps/control-worker` 每次唤醒从 PG 扫描，使用事务行锁 / occurrence 唯一约束。新 Work session、带 trigger 的 prompt 和 occurrence 同事务写入。现有 `PgPromptDispatcher` / BullMQ / `runOrderedPrompts` 执行并恢复原请求；原用户委托和运行触发来源分别保留。      |
| 授权                            | 创建要求 owner 的个人 Work workspace；每次模型 / effect 前重新检查 source Work、owner 角色、workspace 与原权限。source policy 改变后保守停止，要求新计划而非扩大旧授权。审批仍走既有 fail-closed 路径。                                                          |
| Updates                         | occurrence 的 queued / skipped / terminal 结果构成 PG Inbox，保留阅读状态。侧栏未读计数与站内提示在页面可见时刷新；任务链接独立于 Main chat 的 assistant final，不复制报告正文。                                                                                 |
| VM 生命周期控制                 | PG 个人环境、容量准入、固定 host 归属、generation、跨控制面副本锁及 append-only lifecycle events。BFF 的 owner-scoped wake / suspend / state API 经内部 HTTP adapter 调用 Node Agent。                                                                           |
| Node Agent                      | 请求认证和 PG assignment 复核；固定 systemd unit / literal argv；jailer 启动脚本与 CPU / memory 限额；stop 后验证 service 状态。通信失败隔离实例，不用 TTL 自动接管到另一宿主。                                                                                  |

`running` 在当前环境 API 中只表示 systemd 确认 VMM 进程运行，**不表示 guest、Agent 工具、浏览器或安全隔离已就绪**。

## 尚未完成的目标能力

默认 `EXECUTION_DRIVER=local` 保留现有执行路径。显式 `firecracker` 模式已接上个人会话的 Sandbox 文件 / 命令 / LSP 进程、workspace skills、uploads 与私有 Zendriver MCP 进程。Node Agent 经 PG owner / workspace / generation 复核后转发到专属 vsock；guest 仅持有自己的工作数据和 profile，控制面继续保存 PG 日志、证据与模型凭证。本机开发环境已通过真实 KVM guest、jailer、systemd、generation 间持久盘、私有 vsock、Zendriver 预览和默认拒绝外联验收。开发主机已验证个人 owner 经 BFF → browser-runtime → PG assignment → Node Agent → guest 的真实 Chrome 截图、输入与点击；公网 HTTPS 和 typed web_search 由真实 guest 单独验收；`SANDBOX_PROXY_URL` 为整个 guest 选择宿主提供的 HTTP proxy。尚未证明生产多租户隔离。不能仅启用 inventory 或看到 VMM running 就宣称工具已隔离。

尚未实现 WebRTC、完整 OS 桌面接管、自动空闲停机、VM checkpoint / snapshot、跨宿主 volume attach / fencing、资源公平等待队列、持久 batch item / continuation、授权外部事件触发、跨等待恢复的主动提问以及站外通知 / 安静时段。Scheduled 首批并不宣称已具备这些能力。

目前环境控制 API 必须保持显式 opt-in。它不自动创建用户数据盘、替换旧 workspace 或迁移 Chrome profile。KVM、匹配版本的 Firecracker / jailer、guest kernel / rootfs、独立 UID/GID 和具有出口限制的网络 namespace 必须先由运维提供；缺失时启动失败，不创建空盘冒充用户原环境。生产节点必须选择并由运维确认 host-managed 或 provider-managed 加密；仅限开发的本机 smoke test 可显式设置 `NODE_DEPLOYMENT_MODE=development` 与 `NODE_STORAGE_ENCRYPTION=none`。加密是静态数据保护，不等同于 VM/租户隔离。

## 启用 Browser 观看

部署匹配版本的 server 与 browser-runtime，使用 `BROWSER_DRIVER=zendriver` 与相同的 runtime endpoint / token。Zendriver 自己管理 Chrome，不依赖外部 9222 Chrome；不要用 legacy CDP 端口是否可连来判断 Zendriver 是否可用。runtime 新增私有 `/preview` 端点，使用既有 runtime token。CDP 模式继续只附加已配置的 owner-controlled Chrome，不自动启动替代浏览器。

在一次 browser 工具调用后，响应中出现 **Browser → Open browser**。截图通常在既有浏览器操作之间更新；长操作持有 runtime 锁时显示等待。managed 模式显示 Start browser / Take control、Pause、Return control to agent 和 Restart browser；截图为请求驱动的压缩 PNG，不是连续视频。服务无法连接或认证失败时显示 managed browser service unavailable；服务在线但已空闲回收或未绑定 tab 时显示 no active browser。Sources / View evidence 保持独立。

### Managed browser 交互部署与行为

左侧 **Browser / VM** 可直接打开个人会话浏览器，不依赖先前的 browser 工具调用，也不切换当前对话；现有会话草稿与流保持。页面只列出当前用户的个人会话，沿用既有 owner-only interaction / preview API。VM 面板通过 `/api/me/environment` 显示电源状态，显式 Wake / 确认 Suspend；未启用环境服务时显示 unavailable。电源状态不代表 guest/tool readiness，完整 VM 桌面观看仍未实现。

VM status 与 guest RPC 共用 shared lifecycle lock，不等待整个浏览器进程结束；start/stop 继续使用 exclusive lock。状态同步使用 PG expected-state / generation 比较，旧 status 不能覆盖并发 quarantine；用户断线 / 10 秒 status deadline 不会把 VM 标成 quarantine，Web 读取有 15 秒超时。

HTTP 501 表示 interaction 未配置，可使用只读 preview；503 表示临时不可达，保留交互窗口并以五秒间隔重连或点击 Retry connection。重连只读 state，不自动重试 Take control 或任何输入；旧画面与待执行输入在连接失败后失效，本地文本草稿保留。部署匹配的 Web/server/worker/browser-runtime；常驻的 browser-runtime 服务需要重启加载 adapter 更新，不能仅依赖 Web 热更新。

先应用 migration `0016_great_gressill.sql`，再部署匹配的 browser-runtime、server、worker 和 Web。`BrowserInteractionPort` 与 Zod DTO 定义在 contracts；浏览器运行时私有 `/interaction` 仅接受既有 runtime token；BFF `/api/sessions/:id/browser-interaction` 仅允许真实个人 session owner。前端不得提交 owner、宿主路径、CDP endpoint、JS 或 selector。legacy CDP 和旧部署继续使用只读 preview。

Take control 等待已准入的 Agent 操作结束，然后进入 human epoch；一个 view 同时持有控制权。输入要求匹配 generation、epoch、递增 sequence 和 request UUID。基于画面的动作要求最近 5 秒内的 frame，运行时复核 tab / document / fingerprint；连续 text/key 可使用 runtime 签发、PG 持久化的 opaque keyboardId，每次仍复核 owned tab / document / focus revision，受当前 controller 与 15 秒控制租约约束。焦点移走再返回也会失效；keyboardId 不能授权坐标动作或导航。PG 预留输入后才执行，重复 request 不再产生网站 effect；已确认的执行前 stale target 记录 none，不确定的执行失败或崩溃保留 unknown / quarantined，需显式接管观察。只记录 actor / 控制状态 / effect metadata，不保存键入文字、URL 或图片。关闭 / 隐藏页面或控制租约到期后暂停，不自动把控制还给 Agent；显式 Return control 后，使用旧页面目标的交互必须先取得新观察；navigate / web_search 自身会产生新观察，可以直接继续，不需要为恢复 stale state 再问用户 go-ahead。Viewer 断线不会中止已准入的截图并杀死 Chrome。

Viewer 的页面内拖放使用 pointer capture；按下后固定起始 frame/尺寸，空闲轮询改为 heartbeat，不替换画面或淘汰起始 receipt。松开时只发送一次既有 drag action，仍要求 5 秒内 frame；过长手势会被拒绝，必须刷新后重新操作。取消、丢失 capture、view 尺寸变化、隐藏/关闭或控制权变化会丢弃手势；图片外松开和非左键拖动不派发。此功能不包含从本机拖入文件上传。

Web 对 text/key 使用 `capture: false`，ack 返回 effect 与可用的新 keyboardId，不等待 PNG；指针动作仍请求更新画面。输入队列优先于空闲截图轮询，相邻文本在 35ms 窗口合并，不跨按键、指针或控制权边界；IME composition 只提交完成文本，粘贴与 Enter/Tab 保持顺序。可在 “Type text locally” 文本框本地编辑，点击 “Insert text” 插入远端焦点；不会自动发送 Enter，轮询和待执行输入不会重建文本框或覆盖本地草稿。草稿仅在确认插入且用户未继续编辑后清空；结果未知时保留文本，不自动重发。截图仍走同一 browser lock，不是独立视频通道，也不保证固定刷新率。新增 DTO 字段要求部署匹配的 Web/server/worker/browser-runtime；旧 PG JSON controls 自动默认 keyboard=null，无需新 migration。

用户明确接管后可在私有视图处理登录输入；观看者的敏感页面预览仍被抑制。截图只发给用户，不写入证据或模型上下文。人类操作会使当前 browser 状态凭据失效，已保存的 immutable sources 保持可引用。整个桌面、WebRTC、uinput 和跨任意 guest 程序的全局互斥尚未实现；当前机制仅覆盖私有 managed browser adapter，维持 `trusted-managed` 标签。

## 启用 Scheduled / Updates

1. 应用 Drizzle migrations `0012`–`0014`，部署匹配的 server 和 agent-worker。
2. 配置现有 PostgreSQL / Redis / auth / workspace，server 与 agent-worker 均设置 `SCHEDULING_ENABLED=true`。
3. 启动 `pnpm start:control`，向该进程提供 `DATABASE_URL` 与 `SCHEDULING_ENABLED=true`。本地从仓库根目录运行，或显式传环境变量；不依赖 VM 内 cron。
4. K8s 部署使用 `deploy/docker/Dockerfile.control-worker`，设置 Helm `controlWorker.enabled=true`。默认两个副本，PG 锁与唯一约束协调；health readiness 检查最近成功的 reconciliation。
5. 在 Scheduled 选择已有的个人 Work workspace、保存原始请求并确认本地时刻。每个 occurrence 创建独立 Work，更新在侧栏 Updates 与 Scheduled 页面中查看。暂停只影响未来 occurrence；当前任务通过其 Stop 控件取消。

默认 missed policy：到期后超过 60 秒才被 scheduler 处理，记录 `skipped / missed`，推进到未来，不执行历史积压。同一 schedule 尚有 queued / running / approval-waiting 的 run 时，新 occurrence 记录 `skipped / overlap`。夏令时缺失分钟跳过，重复分钟取第一次；once 执行 / 跳过后自动禁用。暂停 / 恢复用 expected revision，旧 occurrence 不重写。

Run 和网站 effects 的语义不同：occurrence / prompt 去重不能保证外部 effects exactly once；未知命令沿用 journal / torn-tail 恢复，禁止自动重发副作用。Scheduled 使用既有审批超时语义；尚不支持跨长时间审批等待自动恢复。

## 实验性环境管理 API

仅 server 设置管理员提供的 `FIRECRACKER_NODES` JSON inventory 及 `NODE_RUNTIME_TOKEN`。例如：

```json
[{ "id": "host-1", "endpoint": "https://node.example.com/", "vcpus": 8, "memoryMiB": 16384 }]
```

inventory 中 CPU / memory 是扣除宿主和基础服务余量后的可准入容量。初始单用户档位为 2 vCPU / 2048 MiB，并为每个 VMM 额外预留 256 MiB；运行内存不超卖；停止确认之前和 quarantined 状态仍计入容量。资源不足返回冲突 / waiting-capacity 原因，当前尚不自动排队。

可用 API：`GET /api/me/environment`、`POST /api/me/environment/wake`、`POST /api/me/environment/suspend`。POST 只接受空对象，不能提交 owner、host 或磁盘路径。响应不返回 node endpoint、generation、宿主凭证。用户身份沿用已有 `/api/me`。

首次 wake 分配稳定 environment ID 与宿主，生成 operator 可见的 instance manifest；宿主资源未准备好时，状态会失败 / 隔离。运维据此 ID 准备资产并确认旧 unit 已停，再 suspend / wake 进行冷启动验证。该流程目前用于集成测试和运维验证，尚不是面向用户的自动开机体验。

Node Agent 的安装与恢复边界见 [宿主说明](../deploy/firecracker/README.md)。未提供真实宿主资产时只能运行 fake / PG 测试，不能声称通过 live microVM 验收。

## Zendriver 安装与真实浏览器验证

把带 profile 补丁的固定版本安装到持久目录，避免 `.env` 指向被清理的 `/tmp` 构建输出。例如：

```bash
./scripts/build-zendriver-mcp.sh /home/sam/.local/share/trinity/zendriver
```

把 `ZENDRIVER_BINARY` 设置为该目录下的 `bin/zendriver-mcp`，保留现有私有 profile volume 配置，启动 `pnpm start:browser-runtime`。server / worker 无需外部 CDP endpoint，也不会在失败后回退到另一浏览器。

本地 fixture 不访问公网或使用真实用户 profile：

```bash
ZENDRIVER_INTEGRATION=1 \
ZENDRIVER_BINARY=/home/sam/.local/share/trinity/zendriver/bin/zendriver-mcp \
pnpm exec vitest run packages/core/test/zendriver-integration.test.ts
```

它启动独立临时 profile，验证 Unicode 提取、输入、点击、证据持久化、离线图片重放、真实 PNG preview 与密码页隐藏；结束后释放自建进程与 profile。

## 实验性 guest 执行面

1. 准备经过审查的 guest rootfs：Node 22+、本仓库及其锁定依赖、固定补丁版 Zendriver、匹配的 Chrome、所需 LSP servers 和 systemd。rootfs 只读；生产用户数据盘须由运维预先创建并启用经确认的 host/provider encryption。仅限开发的本机 smoke test 可显式使用未加密数据盘。代码不会格式化或自动替换用户数据盘。
2. 镜像把私有数据盘挂载到持久目录，再分别 bind mount 到 `/workspace` 与 `/var/lib/trinity/browser`。前者必须与 server / worker / Node Agent 的 `WORKSPACE_ROOT` 绝对路径一致，后者只供 guest 浏览器基础设施使用。创建非 root `trinity` 用户并授予这些目录所需权限；保持运行时代码 root-owned / 只读。准备可写 `/tmp`、`/run` 及经批准的 guest 网络配置。guest 不接收代理 URL 或凭证。可选的开发网络由宿主 bridge/NAT/DNS relay 提供 IPv4，并阻止 guest 访问 IPv6 与私有/保留地址；其余公网 IPv4 遵循宿主路由。宿主 proxy provider 和目标名单由运维选择；host egress installer 读取部署 `.env` 的 `SANDBOX_PROXY_URL`，通过通用 adapter 和 DNS relay 为整个 guest 提供 egress，不依赖 Clash。不配置时使用宿主直接路由，不改变控制面网络。安装命令和可选连通性验收见 Firecracker host guide。修改 `SANDBOX_PROXY_URL` 后须通过维护发布应用宿主 gateway 配置；guest 内不配置 proxy。
3. 在镜像中安装 `deploy/firecracker/trinity-guest.service`、`trinity-guest-vsock.socket`、`trinity-guest-vsock.service`。校对 Node 与 `systemd-socket-proxyd` 的实际安装路径。启用 supervisor 和 vsock socket；先验证实际数据盘 mount 已完成，再启动服务。桥接仅监听 guest AF_VSOCK 4050 与私有 Unix socket，不向 guest 网卡开放 RPC。
4. Node Agent 设置 `NODE_GUEST_ROUTING=true` 和与控制面相同的 `WORKSPACE_ROOT`。它继续只在宿主 loopback 监听，远程连接需要管理员提供 TLS 代理及访问控制。vsock 的 CONNECT 协议遵循 [Firecracker 官方说明](https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md)。
5. server、agent-worker、browser-runtime 同时设置 `EXECUTION_DRIVER=firecracker`，提供相同 `FIRECRACKER_NODES` 和 `NODE_RUNTIME_TOKEN`；server / worker 保持 `BROWSER_DRIVER=zendriver` 与既有 private runtime endpoint/token。guest 不接收这些 host/PG/provider 凭证或 `SANDBOX_PROXY_URL`；其环境由 guest service 的固定配置决定，浏览器 egress 由宿主网络网关执行。
6. Launcher 将 environment、generation 和 tenant/user UUID 写入 guest kernel boot metadata。guest 只接受匹配的 generation，durable Chrome profile 由 boot identity 决定；不是模型可传入的路径。共享 supervisor 在 guest 模式无需挂载或配置自己的 `BROWSER_PROFILE_DIR`，guest service 仍必须提供受保护的 profile 目录。
7. 个人 Chat / Work 使用 PG 中已绑定的相对 workspace 路径。团队及不受支持的 legacy session 拒绝执行，不回退本机。旧工作数据和旧 Chrome profile 不会自动迁移，启用前必须由运维完成一致性迁移。

K8s chart 已提供 `config.executionDriver`、`config.browserDriver`、`config.browserRuntimeEndpoint` 和 `secrets.browserRuntimeToken`，沿用 host inventory/token。外部 host/supervisor 必须加入显式 egress allowlist；不自动开放公网。部署参数必须匹配，缺项时启动失败。

Guest subprocess 的输入按序号去重，输出按字节 cursor 重放与确认；未确认输出最多 4 MiB，输入排队最多 1 MiB。句柄 120 秒没有 RPC 活动时终止并释放容量，断开 worker 不会把失败操作自动重发到新 VM。该机制不等于持久 batch continuation，guest 重启也不会恢复旧 subprocess。远程 process stop 无法确认时返回失败；不据此释放浏览器 generation 的恢复保护。

验证包含 Node Agent/vsock Unix socket 集成测试、所有权与 generation 拒绝、上传转发、process stdio 去重与真实 Zendriver 经 guest RPC 返回 PNG。本机已安装 Firecracker/jailer v1.17.0 并存在 `/dev/kvm`；独立 smoke 镜像的真实 KVM boot / vsock 检查、开发 guest 双次启动，以及 jailer/systemd/私有 vsock/隔离网络拒绝外联验收均已通过。上述结果仅限这台明确标记为 development-unencrypted 的主机和开发镜像，不证明生产隔离。个人 owner-scoped PG assignment 路由已通过本机交互验收；公网搜索连通性单独验收，不能由本地 fixture 成功推断。

开发 guest CLI 已通过本地 socket fixture + 真实 Zendriver / Chrome 测试；实际 KVM acceptance 也完成了双 generation 启动，覆盖持久文件、非 root 命令、环境净化、skills、guest 拒绝旧 generation、PNG preview、jailer/systemd 和默认 guest egress denial。jailer runner 另有可选的真实 DNS/TCP egress 验收。后续环境镜像变更时需重跑相应验收；原独立 dummy vsock smoke 不能代替真实 guest 测试。

2026-10-26 本机开发环境已有个人 PG assignment；真实 Firecracker Chrome 已通过 owner API 返回 PNG，前端输入 Ada 并点击按钮得到 Hello Ada。`example.com` HTTPS 单独验收成功。使用宿主 egress 并修复 anchor 包裹 heading 的提取后，Google typed web_search 已返回文本 receipts 和结果链接；发行版安装路径也已通过 maintenance release 与 fresh generation 的真实 HTTPS / web_search 验收；运行中的配置和 binary 路径均为持久安装位置，不依赖临时修复目录。迁移与身份检查不能替代生产隔离验收。
