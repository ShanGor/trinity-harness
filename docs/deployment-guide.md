# Browser deployment

Trinity currently attaches to an existing user-owned Chrome over CDP. On this machine the endpoint is port **9222**, already configured by `BROWSER_CDP_ENDPOINT=9222` in the local environment. Managed Chrome is not launched or used.

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

## TODO: managed Chrome deployment

Managed Chrome is outside the current implementation and must not be used as an automatic fallback. Future deployment work includes:

- provisioning Chrome and session-isolated profiles without ambient credentials;
- enforcing browser-side egress for redirects, subresources, DNS/private destinations, WebSockets, workers and control endpoints;
- blocking/quarantining downloads, keeping uploads disabled, and implementing capture privacy/redaction;
- defining authenticated takeover, lifecycle cleanup and deployment coordination;
- closing alternate model-facing browser/control/artifact routes before asserting enforced-mode guarantees;
- validating the boundary with controlled fixtures before enabling it.

## Interactions, images and retained artifacts

Actions default to per-operation approval. Explicit policy entries `browser.click`, `browser.fill`, `browser.key`, and `browser.scroll` can allow/deny them. A broad `browser: allowed` or `agent-browser` executable grant does not authorize actions. `danger-full-access` deliberately permits all operations. Missing approval channels deny. Use a fresh delivered snapshot and inspect post-action output; provide optional `readiness: {text, timeoutMs}` when a visible outcome matters. Live browser races remain possible in shared owner-controlled Chrome; avoid concurrent interacting turns and user input on the same browser during critical actions. An `applied` driver acknowledgment does not establish that a website accepted or completed the task.

Screenshots are bounded to 2048×2048, 2 MiB each, four images and 6 MiB per turn. Crop coordinates are viewport CSS pixels; returned image coordinates map through `crop` and `scale`. Suspected credential URLs and recognized sensitive forms are refused. This is conservative detection, not complete private-page redaction. Images appear in Sources / View evidence through a dedicated session-authorized endpoint; generic browser artifact downloads stay blocked. PNG bytes are carried through the model image path, never inline base64 in tool JSON.

Artifacts referenced by retained events/citations are kept. Automatic GC is disabled. Orphan cleanup must use the full retained PostgreSQL log, wait beyond the longest execution/recovery window, and remove only confirmed unreferenced keys; Redis truncation and copied fork receipts are insufficient authority.

## Model comparison

Run the separately opted-in controlled fixture comparison with the same existing Chrome and configured model (two repeats, article/documentation/table/interaction tasks, legacy → saved capture → checked interaction):

```sh
TRINITY_RUN_BROWSER_EVAL=1 TRINITY_TEST_CDP_ENDPOINT=9222 \
  node --env-file=.env node_modules/vitest/vitest.mjs run packages/core/test/browser-research-eval.test.ts
```

Results default to `/tmp/trinity-browser-evaluation.json`; override `TRINITY_BROWSER_EVAL_REPORT`. The runner records actual cumulative provider tokens, calls, bytes, latency, citation failures, answers and explicit coverage checks. It does not contact public websites or submit external account actions. Review the answers as well as metrics before rollout; synthetic fixtures do not establish current-world research quality. See [research-evaluation.md](./research-evaluation.md).

Screenshot paint readiness is bounded. A background or minimized shared Chrome may not produce animation frames: the PNG is retained as partial visual evidence, with an explicit warning that pixels may lag the DOM. Coordinate actions require a ready screenshot; reobserve after bringing Chrome into view. Native controls use a fixed checked DOM activation, which does not supply a trusted user gesture. Custom controls and coordinate input use the pointer path; do not automatically retry an unknown effect.
