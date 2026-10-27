# Browser deployment

Trinity defaults to attaching to an existing user-owned Chrome over CDP. On this machine that endpoint remains port **9222**. An explicitly configured Zendriver runtime is now available as an alternative; this implementation does not switch the local configuration automatically.

## Existing CDP Chrome

Configure the same endpoint on the inline server and agent worker:

```dotenv
BROWSER_CDP_ENDPOINT=9222
# Optional: restrict authenticated browser use to this user UUID.
# If omitted, the owner is the account identified by ADMIN_EMAIL.
# BROWSER_CDP_OWNER_ID=<owner-user-uuid>
```

A bare port refers to loopback on the machine running the CLI. Containers or remote workers need an explicit reachable HTTP/WebSocket endpoint; their loopback does not refer to the Chrome host. Keep the control endpoint within the owner’s trust domain.

Install a matching `agent-browser` CLI on the executing server/worker PATH. The adapter supports the validated **0.38.x** protocol; this machine uses **0.38.2**. The npm package requires Node 24 for its installation tooling; the native CLI can execute independently of Trinity’s Node 22 runtime. Stock Docker images do not provision Chrome or the CLI: an operator-provided image layer/native installation is required for CDP capture there. Do not run `agent-browser install` as part of Trinity startup.

With the endpoint configured, the `browser` tool advertises `navigate`, `read_page`, `get_page_text`, scoped `click`/`fill`/`key`/`scroll`, `screenshot`, and saved `read_observation`/`search_observation`. Without an endpoint it advertises saved operations only. Typed operations:

- checks the authenticated owner, personal session and tenant, rejecting closed/team/other-owner sessions;
- uses a deterministic named session, explicit `--cdp` and `--pin-tab` on every command;
- validates the discovered browser WebSocket endpoint and CLI version, refusing launch/relaunch or a replacement connection;
- restores its owned CDP target ID from successful session results after restart and never returns the other tabs’ inventory;
- preserves Chrome and the user’s tabs, while saved observations remain readable without a live connection.

The M1 server without authentication is for trusted local use. Worker subagents do not inherit the parent’s browser access. Tool/session permissions still apply; a CLI executable grant does not establish a typed-tool grant.

Runtime catalogs and the bundled browser skill direct ordinary browsing through the typed `browser` operations in the current tool schema. The adapter handles CLI checks, CDP connection and extraction. Operator CLI troubleshooting is a separately loaded skill resource (`references/cli-diagnostics.md`) for explicit diagnostic requests. This instruction change leaves Bash policies unchanged and does not claim to enforce tool selection. Loaded skill snapshots refresh on the next model step when their source changes.

A fresh authenticated `workspace-write` session on 2026-10-11 verified the configured model's choice against a controlled localhost page and linked details: it loaded the bundled skill, used `browser.navigate` and `browser.click`, recorded accepted research references and completed with the correct date, access restriction and source links. Both browser calls succeeded; no direct browser Bash calls occurred. The fixture-link click received a one-time approval through the normal authenticated API. Deterministic tests also check the actual model-request schemas for live and saved-only registries. This is a routing smoke check, not a general model-quality or enforcement guarantee.

This is recorded as `securityMode: "trusted-cdp"` in observations and deliveries. It shares the existing Chrome’s accounts/cookies. It does not establish browser-network egress enforcement, private-page redaction, deployment-wide output budgets, or isolation from legacy Bash/control routes. The stronger `enforced` deployment requirements remain in design §12 and the improvement plan; the trusted adapter does not claim to satisfy them.

## Validate the existing connection

The opt-in integration check uses only a controlled localhost fixture and a dedicated pinned tab. It closes that fixture tab, preserving Chrome and unrelated tabs:

```sh
TRINITY_TEST_CDP_ENDPOINT=9222 pnpm exec vitest run packages/core/test/browser-cdp-live.test.ts
```

Normal `pnpm test` skips this check unless the endpoint is supplied. Unit tests cover missing/wrong owners, endpoints, unsupported versions, unexpected launch, malformed output, cancellation and committed target recovery without a real browser.

## TODO: enforced managed Chrome deployment

The trusted-owner Zendriver mode below is implemented. Enforced multi-tenant managed browsing remains future deployment work, and must not be used as an automatic fallback. Remaining work includes:

- provisioning Chrome and session-isolated profiles without ambient credentials;
- enforcing browser-side egress for redirects, subresources, DNS/private destinations, WebSockets, workers and control endpoints;
- blocking/quarantining downloads, keeping uploads disabled, and implementing capture privacy/redaction;
- defining authenticated takeover, lifecycle cleanup and deployment coordination;
- closing alternate model-facing browser/control/artifact routes before asserting enforced-mode guarantees;
- validating the boundary with controlled fixtures before enabling it.

## Interactions, images and retained artifacts

Actions default to per-operation approval. Explicit policy entries `browser.click`, `browser.fill`, `browser.key`, and `browser.scroll` can allow/deny them. A broad `browser: allowed` or `agent-browser` executable grant does not authorize actions. `danger-full-access` deliberately permits all operations. Missing approval channels deny. Use a fresh delivered snapshot and inspect post-action output; provide optional `readiness: {text, timeoutMs}` when a visible outcome matters. Live browser races remain possible in shared owner-controlled Chrome; avoid concurrent interacting turns and user input on the same browser during critical actions. An `applied` driver acknowledgment does not establish that a website accepted or completed the task.

Screenshots are bounded to 2048×2048 and 2 MiB each. There is no cumulative screenshot count or image-byte ceiling per turn. Crop coordinates are viewport CSS pixels; returned image coordinates map through `crop` and `scale`. Suspected credential URLs and recognized sensitive forms are refused. This is conservative detection, not complete private-page redaction. Images appear in Sources / View evidence through a dedicated session-authorized endpoint; generic browser artifact downloads stay blocked. PNG bytes are carried through the model image path, never inline base64 in tool JSON.

Artifacts referenced by retained events/citations are kept. Automatic GC is disabled. Orphan cleanup must use the full retained PostgreSQL log, wait beyond the longest execution/recovery window, and remove only confirmed unreferenced keys; Redis truncation and copied fork receipts are insufficient authority.

## Model comparison

Run the separately opted-in controlled fixture comparison with the same existing Chrome and configured model (two repeats, article/documentation/table/interaction tasks, legacy → saved capture → checked interaction):

```sh
TRINITY_RUN_BROWSER_EVAL=1 TRINITY_TEST_CDP_ENDPOINT=9222 \
  node --env-file=.env node_modules/vitest/vitest.mjs run packages/core/test/browser-research-eval.test.ts
```

Results default to `/tmp/trinity-browser-evaluation.json`; override `TRINITY_BROWSER_EVAL_REPORT`. The runner records actual cumulative provider tokens, calls, bytes, latency, citation failures, answers and explicit coverage checks. It does not contact public websites or submit external account actions. Review the answers as well as metrics before rollout; synthetic fixtures do not establish current-world research quality. See [research-evaluation.md](./research-evaluation.md).

Screenshot paint readiness is bounded. A background or minimized shared Chrome may not produce animation frames: the PNG is retained as partial visual evidence, with an explicit warning that pixels may lag the DOM. Coordinate actions require a ready screenshot; reobserve after bringing Chrome into view. Native controls use a fixed checked DOM activation, which does not supply a trusted user gesture. Custom controls and coordinate input use the pointer path; do not automatically retry an unknown effect.

## Chat session storage

New Main and side Chat created by the stock client use `workspace-write` with normal approvals, matching the default Work policy. Chat creation and its recovery descriptor must never force `read-only` based on kind. Explicit per-session policies remain authoritative; an admin role does not bypass them. Existing sessions and pending creation retries retain their recorded policy to preserve idempotency and deliberate restrictions. Correct an affected existing session through the authenticated `POST /api/sessions/:sessionId/policy` endpoint with `{"policy":"workspace-write"}` before submitting a new prompt; do not bulk-upgrade stored policies or rewrite creation events.

Chat allocates `$WORKSPACE_ROOT/sessions/<user_id>/<session_uuid_v7>` automatically; Task/Work uses the selected personal/team workspace. Keep this directory on the same persistent shared workspace disk accessible to server and workers. Chat uploads retain blob storage references and writable copies under their session's `uploads/` directory. Browser evidence continues to use the existing artifact store with bounded retrieval.

Apply migration 0010 before running this version. Existing null-workspace Chat sessions acquire their immutable binding on first execution or upload through a logged transaction; no original event is rewritten. A missing binder or invalid directory prevents execution instead of falling back to the deployment root. Configured tools and permissions apply equally to Chat and Task/Work.

## Managed Zendriver (opt-in)

This mode uses the Rust `zendriver-mcp` from TurtIeSocks/zendriver-rs, pinned to **0.16.37** with its published lockfile and default optional features disabled. Trinity applies tracked patches for the private process-level `--user-data-dir` argument and native human input. The latter fixes held-button drag events and adds an optional private `immediate` mouse flag for human clicks. The model-facing Trinity tool schema remains unchanged. Build the patched executable at setup time, never during a turn:

```bash
./scripts/build-zendriver-mcp.sh /opt/zendriver
```

The script applies `apps/browser-runtime/patches/zendriver-mcp-user-data-dir.patch`, `zendriver-mcp-human-input.patch` and `zendriver-mcp-viewport-capture.patch` to the pinned crate source and installs the executable under `/opt/zendriver/bin`. `deploy/docker/Dockerfile.browser-runtime` performs this build automatically. An unpatched binary rejects the runtime's `--user-data-dir` argument and fails closed. The human-input adapter requires the `immediate` flag; the viewport-capture patch fixes screenshots of tabs opened by native Chrome bookmarks using a bounded layout-metrics clip. Rebuild the executable before restarting Browser Runtime. For Firecracker, rebuild the guest rootfs with this binary, then use the [maintenance release procedure](../deploy/firecracker/README.md#draining-a-node-before-release), preserve user data disks and wake a fresh generation. Restarting the control plane alone does not update the guest executable.

The tested Chrome build is **155.0.8059.84**. Runtime startup verifies the binary version; each launch verifies the Chrome product version, native profile and requested isolation/CSP overrides. `ZENDRIVER_CHROME_VERSION` explicitly selects another administrator-validated build. Upstream reports RMCP 2.2.0 in its MCP handshake; this is checked separately from executable identity. Chrome must run with its sandbox available as a non-root user. The child environment is minimal and does not inherit CI's automatic no-sandbox switch, runtime credentials or provider keys.

Run `pnpm db:migrate` for migration 0011. The supervisor requires PostgreSQL ownership metadata and the same `WORKSPACE_ROOT`/blob storage as server and worker. Configure the same administrator-generated `BROWSER_RUNTIME_TOKEN` (at least 32 characters) in the supervisor and every server/worker. Remove any `BROWSER_CDP_ENDPOINT` assignment from the environment **and dotenv files** when selecting Zendriver:

```dotenv
BROWSER_DRIVER=zendriver
BROWSER_RUNTIME_ENDPOINT=http://127.0.0.1:3010
BROWSER_RUNTIME_TOKEN=<administrator-generated-random-secret>
BROWSER_PROFILE_DIR=/opt/local/browser-data
ZENDRIVER_BINARY=/opt/zendriver/bin/zendriver-mcp
ZENDRIVER_CHROME_VERSION=155.0.8059.84
```

`BROWSER_PROFILE_DIR` is required by the supervisor and must point to operator-provisioned persistent encrypted storage, writable by the browser-runtime service UID/GID. Mount it only into the browser-runtime process/container. Trinity creates private directories at `<root>/<tenant-id>/<user-id>`; Chrome stores its `Default` profile inside each directory. Profile paths come from authenticated session metadata and are never model arguments or event data. Directory permissions are set to `0700` and lock files to `0600`.

With `EXECUTION_DRIVER=firecracker`, `SANDBOX_PROXY_URL` selects the host-provided HTTP proxy for the whole guest. The host egress installer reads the deployment `.env` (or `--env-file`) and installs the guest-only adapter and DNS relay; empty/unset selects direct host routing. No URL or proxy credentials enter the guest. The control plane and host default route stay unchanged. Use the maintenance release wrapper for host changes and validate a fresh assigned guest afterward; see the [host guide](../deploy/firecracker/README.md#whole-guest-egress-with-sandbox_proxy_url).

Start the separate supervisor with `pnpm start:browser-runtime` (or `pnpm dev:browser-runtime` for development), then run server/worker normally. `DATABASE_URL`, `WORKSPACE_ROOT` and the configured owner's `ADMIN_EMAIL` or `BROWSER_CDP_OWNER_ID` must agree across processes. Only that owner's personal sessions can use this trusted local process mode, for both Chat and Work. Team/other-owner/closed sessions are denied. Worker subagents remain saved-only.

The supervisor binds loopback by default on port 3010 and authenticates every request. A remote `BROWSER_RUNTIME_ENDPOINT` must use HTTPS; expose the supervisor only through an operator-provided authenticated TLS proxy/network policy, never directly on the public internet. No arbitrary upstream MCP endpoint is accepted. `BROWSER_RUNTIME_MAX_SESSIONS` defaults to 4 shared browser instances and `BROWSER_RUNTIME_IDLE_MS` to 300000. Exhausted capacity refuses new allocations. Restarting workers keeps the surviving supervisor/browser; idle expiry, Main closure and normal supervisor shutdown stop owned processes while retaining durable user profiles. Main, side chats and personal Work resolve to the same user's Main browser anchor and reuse one Chrome process/profile; closing a side chat leaves it running. All views share a single controller lease, while model command journals and evidence stay in their originating sessions. The current managed mode remains restricted to the configured owner's personal sessions and does not provide hostile-tenant isolation.

`deploy/docker/Dockerfile.browser-runtime` is an opt-in build recipe: supply an HTTPS `CHROME_DEB_URL` and its independently verified `CHROME_DEB_SHA256` as build arguments. It compiles the pinned Rust binary and verifies the supplied Chrome version. This recipe requires compatible amd64 Chrome packaging and a deployment that permits Chrome's sandbox. The stock Helm chart does not provision managed-browser isolation, TLS proxying or this workload; those remain deployment gates. Use a private container network/sidecar proxy or trusted host topology and a writable shared workspace. Do not call this `enforced` mode: LocalSandbox and separate profiles do not provide hostile-tenant isolation or a network firewall. Existing Bash routes remain subject to their existing policies.

### Interactive browser frames and human control

Apply migration `0016_great_gressill.sql` before deploying the matching browser-runtime, server, worker and Web. In **Browser → Open browser**, choose **Start browser** or **Take control**, click the picture and type, drag or scroll; use the address field to navigate. **Return control to agent** explicitly resumes model browser access after a fresh observation. Closing/hiding the view or losing the controller lease pauses control. **Restart browser** disposes the owned browser without deleting its durable profile.

The owner-only BFF `POST /api/sessions/:id/browser-interaction` forwards validated structured commands to the private runtime `/interaction`. Generation, epoch, request UUID, sequence and a recent frame fence each input. Request reservations persist before dispatch; unknown outcomes are never automatically replayed. Pixels and typed values are excluded from ACP/model history; control/effect metadata invalidates current browser evidence. Viewer cancellation discards admitted screenshot responses without killing Chrome. Sensitive frames require explicit control and are delivered only to that view. Legacy CDP remains read-only. This covers the managed browser adapter, with the existing `trusted-managed` limitations; full OS desktop control and enforced coordination with arbitrary guest processes remain pending. See [runtime behavior](runtime-implementation.md#managed-browser-交互部署与行为).

### Recovery and uncertain outcomes

The runtime holds a PostgreSQL session lock through the complete operation, evidence capture and command-journal outcome write. Request identity includes the originating tool call and normalized arguments. Duplicate completed commands return the recorded result; a durable dispatch without an outcome returns an unknown effect and is never resent. HTTP timeout/cancellation does not assert that website effects were undone. The supervisor stops its owned process group before releasing local control and invalidates old target generations. Saved observations remain readable offline and retain their original capture time.

After a **graceful** stop, the next call can allocate a new generation and reuse the same durable profile. After a **crash**, an active row owned by an old supervisor blocks automatic takeover: first stop the old runtime container/process group and confirm its Chrome descendants cannot continue. Only then may an administrator invalidate the matching `browser_runtimes` row (`status='invalid'`, scoped to its session ID and old owner ID) and remove the corresponding stale `<BROWSER_PROFILE_DIR>/.locks/<tenant-id>-<user-id>.lock`. Keep the user's profile directory, `browser_commands` and evidence intact. Delete the profile directory only after stopping its browser and when intentionally revoking that user's stored login state. This explicit recovery requirement prevents a second browser from acting alongside an unconfirmed old process; it is not automatic process reclamation.

The real browser compatibility check contacts only a local fixture:

```bash
ZENDRIVER_INTEGRATION=1 ZENDRIVER_BINARY=/absolute/path/to/zendriver-mcp pnpm exec vitest run packages/core/test/zendriver-integration.test.ts
```

It checks Unicode evidence, input replacement, key/click behavior, PNG capture, successful receipts and offline screenshot replay. Ordinary deterministic tests fake MCP/runtime peers. Public-site bot-defense improvements have not been measured; compare user-identified failing sites separately before changing the default driver.

## Runtime latency diagnostics

On one development machine, give each process a different Prometheus port. Restart the existing process with its port setting rather than starting a second queue consumer or binding the same API port twice. For example, run these in separate terminals in place of the usual server/worker commands:

```bash
OTEL_PROMETHEUS_PORT=9464 pnpm dev:server
OTEL_PROMETHEUS_PORT=9465 pnpm dev:worker
```

For managed browsing, restart the existing Browser Runtime with `OTEL_PROMETHEUS_PORT=9466 pnpm dev:browser-runtime` to capture that process's guest RPCs as well. Keep metrics endpoints on an operator-controlled network. Prometheus exporters bind a listening port; do not expose it through public ingress. Production deployments can instead use the existing `OTEL_EXPORTER_OTLP_ENDPOINT` collector setting.

Prometheus-only mode disables the SDK's implicit localhost trace exporter, so it needs no collector. An explicit OTLP endpoint uses HTTP/protobuf (`/v1/traces` and `/v1/metrics`, normally port 4318).

After a representative request, inspect worker metrics:

```bash
curl --fail --silent http://127.0.0.1:9465/metrics | rg 'trinity_(llm_latency_ms|guest_rpc_duration_ms)_(sum|count)'
```

Compare counter differences across that request (sum difference divided by count difference gives the mean per phase). Metrics are cumulative per process, and a multi-step turn may contain several model calls and many RPCs. Do not add first-output/text times to full model duration: these are overlapping measurements. Exporters expose histograms for aggregate distributions; use OTLP traces when individual calls matter.

- Model `preparation` measures the dispatch guards, budget reservation and context receipt persistence before provider dispatch. `first_output` includes reasoning/text/tool calls; `first_text` starts at the same dispatch boundary but requires nonempty answer text. `duration` runs through stream consumption, excluding subsequent usage persistence. Purpose distinguishes assistant/subagent/compaction calls.
- Guest `metadata` measures the router's session/user lookup, `environment` measures assignment lookup and any lifecycle reconciliation/wake, and `transport` includes Node Agent checks, vsock, guest work and response decoding. `total` includes all RPC phases and validation. Operation labels distinguish actual file/exec/browser allocation from subprocess transport reads/writes.
- A `processRead` with no new output intentionally long polls for up to 25 seconds; it runs concurrently with process writes and is not a browser-command latency measurement.
- The existing tool and step spans include broader harness work. UI lag after backend completion should be investigated through event delivery rather than inferred from model timings.

No guest image rebuild is required for the telemetry and Node Agent authorization changes described here. For the browser boundary change, deploy the control plane and Browser Runtime first so `browserOpen` no longer carries proxy settings, then rebuild the guest payload/rootfs to remove guest-side proxy configuration and start a fresh guest generation. Restart server, worker and Browser Runtime to load updated dependencies, and run `sudo systemctl restart trinity-node-agent.service` for the host authorization optimization. Restarting the Node Agent does not require restarting a healthy VM. Redis publication and PG-backed gap repair are applied without clearing either store. A lost final publication still requires a later event or reconnect; this is not a transactional outbox.

The subsequent typed guest-file-error change additionally requires a rebuilt guest payload/rootfs and a fresh VM generation. Upgrade the control plane first; old guests remain compatible but keep returning generic errors. Follow the [development guest maintenance instructions](../deploy/firecracker/README.md#development-guest-with-actual-tools-and-zendriver); preserve per-user volumes and do not overwrite an image used by a running VMM. Explicitly denied tools are now omitted from model schemas, while tools requiring approval remain listed. Tool visibility never bypasses execution authorization.

## General action controls

Server and worker now use general action-economy/continuation instructions, a safe current-run policy snapshot and replayable strategy warnings for repeated tool failures or unchanged reads. Stock v2 verification checks for a committed minimal task plan before mutations/unknown-effect calls, including small edits, so a missing final-verification prerequisite is reported before changes run. Routine reads/direct answers need no plan. Existing permission and guest boundaries remain enforced; no physical-host diagnostics are exposed to personal agents.

`TASK_MAX_TOOL_CALLS` optionally sets a shared per-task tool-call ceiling, including parent, children, control calls and attempted rejected waves. Configure the same value in server and worker; Helm exposes `config.taskMaxToolCalls` (default null). Omission remains unlimited. The task captures the setting at creation; changes do not raise previously recorded limits. A complete wave that cannot fit is rejected before approvals/execution, and conservative reservations survive crashes. The next model step concludes without tools if other model budgets permit it. This bounds calls, not semantic quality or the duration of an individual tool. Existing deadlines, quotas, cancellation and per-call timeouts remain separate.

Deploy matching updated event readers/server/worker and rebuild the production web bundle before enabling the new `task/tool_reservation` event writer. These are control-plane changes: no guest image rebuild, Node Agent restart or VM restart is required. Existing development watch processes reload changed sources; production processes need their normal deployment/restart. See [the execution design](intent-execution-design.md#general-action-selection-and-shared-tool-allowance-2026-10-25) and [evaluation procedure](intent-evaluation.md).
