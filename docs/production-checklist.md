# Production Release Checklist — Trinity Harness (M5)

> M5 acceptance gate (docs/design.md §18 "生产发布 checklist 通过").
> Walk top to bottom before declaring a release ready; record evidence
> (command output / screenshot) next to each item.

## Text and source attachments

- [x] Local deterministic coverage verifies source/text recognition, normalized composer uploads, exact original/workspace bytes, invalid UTF-8 rejection and ACP text exclusion from provider media.
- [ ] Deploy the compatible server before the expanded Web picker. Verify HTML/JSON/Markdown/CSS/source uploads and previews through the configured guest Sandbox; no schema migration or guest image update is required.

## Personal calendar and Chinese lunar dates

- [ ] Deploy migrations 0025–0027 and matching server/worker/control-worker/Web
      readers and writers; retire older scheduler writers before calendar schedules.
- [ ] Verify owner isolation, original user/call provenance, disabled-capture
      suggestions, lunar annual/leap/day-30 rules, DST, edits/cancellation and
      immutable outcomes through the authenticated deployed owner route.
- [ ] Run configured-model explicit/inferred/ambiguous/correction capture cases in
      English and Chinese; verify statements do not grant task/external-effect rights.
- [ ] Configure operator-owned VAPID credentials and exact provider origins under
      existing egress policy; accept real-device closed-app notification, quiet-hour,
      snooze, disconnect and expired-subscription behavior. Inbox delivery alone
      does not satisfy external delivery acceptance.

## Account roles and LLM configuration (planned)

Mechanisms are implemented in the checkout. The unchecked gates below concern deployment and production acceptance; local mechanism tests do not certify them. Follow [the plan](improvement-plan-2026-11-17.md), [operations runbook](llm-configuration-operations.md) and [recorded implementation evidence](project-progress.md#account-roles-and-llm-configuration--2026-11-17).

- [x] Local implementation validation: 1,853 passing tests (32 opt-in skipped), lint/typecheck, changed-file formatting, production Web build, fresh/seeded-upgrade migration checks and desktop/mobile administration fixtures. Web build has a large-chunk warning; no paid-provider or production acceptance is implied.
- [x] Direct provider/model revision: atomic connection/key saves, independent connection setup, default/explicit selections, legacy-reselection fences and existing no-output fallback have deterministic coverage. The fake-key browser save cleared credentials and fit a 390px viewport. One transient real-LSP timing failure passed separate/full reruns; final focused UI/API checks also passed. No production migration or live-provider request was performed.

- [ ] Deploy compatible role/event/configuration readers across server, worker, scheduler, Node Agent and clients before target writers. Retire old writers; review/apply migrations and verify Developer→Member, Viewer retention, explicit Expert assignment, last-Admin protection and bounded token refresh/current-role checks.
- [ ] Verify tenant/session access and capability matrix through direct API and background execution, including downgraded roles, stale tokens and invalid Expert overrides. No role bypasses tool approvals or grants additional private-data scope implicitly.
- [ ] Configure production envelope encryption/secret manager, rotation/revocation and private backup/retention policy. Verify write-only secrets never appear in responses, browser persistence, events, model artifacts, telemetry, guest environments or raw SDK errors.
- [ ] Enforce operator endpoint policy through validation, DNS/connect and redirects for both inference and synthetic tests; test private/control/metadata rejection and explicitly allowed internal gateways.
- [ ] Exercise atomic metadata/key/settings saves, CAS/idempotency and source activation, durable audit recovery, revoked-reference rollback, missed Redis invalidation and authoritative per-request refresh across multiple workers. Once activated, database/key-service failure must not fall back to `.env`.
- [ ] Reconcile legacy session models and verify default-following versus explicit/pinned semantics and explicit legacy-profile reselection, current availability/revocation and purpose-specific compaction/child routing. Verify manual emergency switching without restart or interruption/repetition of tools.
- [ ] Verify pre-dispatch route receipt, per-attempt deployment/pricing attribution, quota reservations, unknown usage and cost-bounded rejection for missing prices. Synthetic tests are metered separately from conversation totals.
- [ ] Before enabling automatic fallback, pass no-output eligibility, partial-stream/refusal/cancellation exclusions, provider timing, shared retry/fallback budgets, crash/torn-tail replay and no-effect-repetition regressions. Shared circuit/probe and automatic failback acceptance remain separate later gates.
- [ ] Complete jsdom/fake ACP and agent-browser UI acceptance for role controls, advanced limits, revision conflicts, secret fields, mobile layouts and preserved composer/focus/history/streams. Run implementation tests/lint/typecheck; record opt-in provider and controlled multi-worker outage results separately.
- [ ] Rehearse configuration rollback as a new validated revision and application rollback with compatible binaries; record backups and role/token/source transition boundaries. Do not restore revoked credentials or run old binaries after new roles/configuration activation.

## HTML-first Markdown export rollout

- [x] Materialize rendered HTML/media through Sandbox, then read saved HTML and convert with bundled Turndown/GFM. Captured media uses local paths with original URL/hash provenance. Cancellation, source revocation and conversion failures retain HTML without partial Markdown or recapture.
- [x] Cover nested-frame Unicode content, lists/code, GFM and unsupported tables, source links, local images, paged saved input, source suppression and cancellation with the actual JavaScript converter.
- [x] Build the matching guest and patched capture binary; direct guest acceptance verified capture content, saved HTML and Turndown conversion. The candidate is installed on the local development node at the user's explicit direction, with old image and data-volume backups retained. No native normalizer installation is required.
- [ ] Pass the stricter jailer acceptance. It currently fails at the native prompt text-input check (`guest-default` returned instead of `A中🙂`); do not record the full guest release gate as passed.
- [ ] Confirm the owner-route export on matching deployed components and review independent source/media coverage. The current owner-route smoke ended at an unknown guest process allocation before navigation and was not retried.
- [x] Local development rollout 2026-11-14: presentation-aware application stack and desktop-enabled guest installed through the maintenance gate; prior shared image and assigned disk backup retained. Direct two-boot guest acceptance passed.
- [ ] Jailer acceptance still fails at native prompt input (`guest-default` vs `A中🙂`). The image was installed at the user's explicit request after direct acceptance; do not count the jailer release gate as passed.
- [ ] Authenticated owner-route capture/export for the supplied iframe remains unverified: the post-wake smoke returned unknown guest process allocation and was not retried. Container/API/node health passed afterward.

## Rendered-document capture pilot gates

- [ ] Roll out presentation-aware contracts/readers before the writer and verify the original iframe report on the authenticated guest route: text, links, 44 SVGs and their geometry/styles in the saved/composed HTML. Local deterministic copied-file comparison does not satisfy this gate. Preserve historical artifact hashes and explicit unsupported vector/style omissions; Markdown inline-SVG display depends on the viewer.

The [browser tool design](browser-tool-design.md) is implemented in the checkout with automatic availability through the configured runtime or capture-capable driver and private binary capability negotiation. Existing semantic operations remain supported. The candidate is installed on the local development node, but the jailer and authenticated owner-route checks are incomplete; local acceptance does not establish production acceptance. The following gates apply before general writer rollout.

- [x] Implemented versioned contracts/capability negotiation, privacy-safe fixed serialization, chunk/aggregate limits, cancellation, event-authorized immutable graph/HTML publication and compatible semantic readers. Session writer/recovery reservations count interrupted attempts; orphans are retained conservatively. Generated HTML/export limits are explicit. Broader owner/tenant storage acceptance remains below.
- [x] Local pinned-Chrome fixtures verify nested OOPIF parent/owner identity, duplicate URLs, opaque documents, shadow content and decoded image transfer without refetch. Deterministic cases verify mutation/corrupt chunks, privacy, limits, source suppression, orphan/cross-session denial, conversion paging, mappings and no browser allocation for saved operations.
- [ ] Complete the remaining adversarial media/frame/privacy and crash/replay matrix on the actual guest, including takeover mid-transfer and uncertain transport outcomes. Review deployment-wide owner/tenant storage quotas and conservative retention. Preserve unsupported canvas/advanced-SVG/resource-cache/refetch scope; no completeness or privacy-isolation claim follows from local fixtures.
- [x] Install the actual guest TypeScript, patched binary and Chrome image through the node maintenance API after direct fixture acceptance. The previous shared image and a copy of the assigned data disk are retained; all application containers and the Node Agent were restarted.
- [ ] Verify guest capability/build IDs and a rendered-document capture/export through the authenticated owner route on a fresh generation. The first smoke returned unknown process allocation before navigation; the guest was stopped through maintenance afterward. The jailer text-input acceptance also remains open.
- [ ] Compare extraction outcomes and call economy on matched real-model tasks, including the reported iframe page; verify live navigation/forms do not require archives and unknown input is never retried. Record coverage limitations instead of claiming universal complete capture or SOTA performance.

## Explanation scope and research input rollout

- [ ] Deploy matching contracts/server/worker and browser skill snapshots, including the preceding browser metadata/guidance repairs. Confirm effective request schemas and running versions. No migration or guest image change is needed.
- [ ] With the model fixed, compare sufficient-context explanations and explicit source-verification tasks. Review scope, evidence, unnecessary calls, latency and supported final answers. Notes must remain optional; new URLs alone do not establish useful progress. Deterministic tests do not establish semantic improvement.

## Approval strategy rollout

- [ ] Deploy matching server, worker and Browser Runtime preflight/classified-target code; refresh old snapshots. No migration or guest image change is needed. Preserve explicit custom session policies and grants.
- [ ] Verify a real-model long-attachment analysis uses bounded continuation/search without approvals or runtime-cache probes. Deterministic fixtures do not prove optimal call quality.
- [ ] Validate representative real-site search/navigation and payment/send/delete controls: no coordinate prompts, generic effects remain unavailable, approvals show a named site/target, and changed pages invalidate old targets. Record the conservative named-file/consent limits and non-atomic overwrite behavior from [approval strategy](approval-strategy.md).

## 1. Data & migrations

- [ ] Apply attachment catalog migration 0018 before matching server/worker readers and writers. Verify cross-tenant pooling, scoped aliases, guest workspace materialization and lost-response recovery in the target deployment. Do not expose raw attachment-pool keys.
- [ ] Record pooled-original/ingestion retention and storage quota policy. Current code retains them conservatively; automatic collection and abandoned staging cleanup are not enabled. Confirm pool boundaries match encryption/residency requirements.

- [ ] `pnpm db:migrate` applied against the production DSN; `migrations/` is at
      the release tag (0000–0004 present, including `model_usage` + `tenants.quota`).
- [ ] `session_events` append-only trigger verified: `UPDATE session_events SET …`
      fails with the trigger error; only the controlled tail-`message/user`
      exception (migration 0003) can delete.
- [ ] PG backup / PITR configured for the cluster hosting the event log.
- [ ] Retention decision recorded for `audit_log` and `model_usage` (prune job
      or partition drop); the event log itself is never pruned.

## 2. Secrets

- [ ] All secrets come from K8s Secrets (Helm `secrets.*`), never from images
      or git: `DATABASE_URL`, `REDIS_URL`, `TOKEN_SECRET` (≥16 chars, rotated),
      `ADMIN_PASSWORD` (rotated after first login), model API keys.
- [ ] Model API keys / `TOKEN_SECRET` never appear in logs or event payloads
      (grep the audit log and a sample of `session_events.payload`).
- [ ] Sandbox env scrubbing on: `SANDBOX_ENV_MODE=minimal` (default) — verify a
      tool child cannot see secrets: ask the agent to run `env | grep -i key`
      in a session and confirm nothing leaks.

## 3. Quotas & metering

- [ ] Tenant quota configured per plan: `PUT /api/admin/quota {"dailyTokens": …}`
      (optionally `hourlyTokens` / `monthlyTokens`); change is audited as
      `tenant/quota`.
- [ ] Over-quota behavior verified: a prompt on an exhausted tenant ends the
      turn with the friendly quota message BEFORE any model call, and
      `GET /api/usage` shows the window usage/limit.
- [ ] `model_usage` rows accumulate per turn (spot-check against the provider
      dashboard for one session).

## 4. Observability

- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_PROMETHEUS_PORT`) set on server,
      agent-worker and audit-consumer; traces arrive: one `trinity.turn` span
      per turn with `trinity.step` / `trinity.tool` / `trinity.approval`
      children (docs/design.md §17).
- [ ] Metrics visible: `trinity.llm.tokens` (input/output by model/tenant),
      `trinity.tools.calls` (ok/error), `trinity.approval.duration_ms`,
      `trinity.turn.duration_ms`, `trinity.turn.steps`, and the worker's
      `trinity.queue.jobs` BullMQ depth gauge.
- [ ] Alert rules at minimum: worker queue depth > N sustained, tool error
      rate spike, approval latency p95, quota-denied turns (turn/end error
      detail match `quota exceeded`).

## 5. Kubernetes

- [ ] `helm lint deploy/helm/trinity-harness` clean; `helm template` reviewed
      for the release values; `helm upgrade --install` succeeds.
- [ ] Workloads run hardened: `runAsNonRoot`, `readOnlyRootFilesystem`,
      drop-ALL capabilities, seccomp `RuntimeDefault` (chart default).
- [ ] NetworkPolicy default-deny active; egress limited to DNS, intra-namespace,
      datastore CIDRs and the explicit allowlist. Outbound internet OFF unless
      `networkPolicy.extraEgressCidrs` deliberately lists it (§12.5).
- [ ] HPA: server 2–20 on CPU; worker scaled (CPU HPA 1–50 by default).
      **Queue-depth scaling**: install KEDA and create a ScaledObject on the
      `agent-turns` BullMQ queue for true 0→N autoscaling (HPA v2 cannot scale
      on queue depth). Suggested trigger: `length` of `waiting`+`delayed` ≥ 1
      → scale up; scale to 0 when idle and cold-start latency is acceptable.
- [ ] Server PDB (minAvailable 1) active; rolling update keeps `/api/health` 200.
- [ ] gVisor (reserved sandbox upgrade, §12.3): cluster provides the `gvisor`
      RuntimeClass ⇒ set `agentWorker.runtimeClassName: gvisor` and re-run the
      smoke suite; tool execution, LSP and bash all pass under runsc.
- [ ] Ingress: SSE buffering disabled (`proxy-buffering: off`,
      `x-accel-buffering: no`), 24h read/send timeouts, TLS terminated at the
      ingress, `proxy-body-size` ≥ 25m (attachment upload).

## 6. Graceful behavior

- [ ] `SIGTERM` drain verified: killing an agent-worker pod lets the in-flight
      turn finish (event log shows a clean `turn/end`) before the process
      exits; server `SIGTERM` closes listeners without dropping committed
      SSE frames.
- [ ] Worker crash recovery: kill -9 a worker mid-turn → next worker replays
      the torn tail and synthesizes the closing event (§7 回放修复).

## 7. Performance (load test)

- [ ] `scripts/load-test.mjs` against the staging deployment passes with the
      release's baseline numbers recorded:
      `bash
BASE_URL=https://staging.example.com ADMIN_EMAIL=… ADMIN_PASSWORD=… \
node scripts/load-test.mjs 50
`
      Gate: error rate ≤ 1% across auth / session+prompt / SSE replay phases.
      Reference single-node numbers (dev box, M5): auth ~3.5k rps, session
      create + prompt ~1.1k rps, 50-way SSE replay wall ~45ms.

## 8. Rollback

- [ ] Rollback plan: previous image tag + `helm rollback <release> <rev>`;
      DB migrations 0000–0004 are backward-compatible for the M5 server/worker
      pair (new columns/tables are additive-only).

## Browser deployment

- [ ] Release the generic behavior follow-up with matching contracts, server, worker, and Browser Runtime readers/writers. Verify discovery metadata across direct and typed search, known redirect comparison, saved-read exclusion, bounded response sizes, and legacy result replay. Verify value-free stale-target reasons and reference-validation scope. No database migration or guest/browser binary rebuild is required. Unknown providers remain unclassified.
- [ ] Validate the follow-up on real guest search pages and dynamic/shared-browser snapshots. Confirm current guidance remains next to the next decision with complete tool pairs and committed phone metadata. Deterministic trace replay measures detection only; it does not establish improved answers, stopping decisions, or public-site access.

- [ ] Complete the [consolidated behavior plan](agent-behavior-improvement-plan-2026-11-10.md), phases A–B, with the current model fixed. Measure harness outcomes alongside repairs. Use common discovery information across equivalent operations and keep provider parsing in adapters. Add bounded stale-target diagnostics. Preserve exact evidence, privacy, replay, and unknown-effect protections. Model comparisons do not block these repairs.
- [ ] Evaluate phases C–E separately before adoption. Check request/delivery continuity, decision briefs, evidence-validation semantics, optional bounded review, and Sources presentation against declared quality, time, and cost thresholds. Add fresh holdout cases. Consider model changes only after applicable harness repairs and evaluation. Do not infer semantic quality from mechanism tests or claim SOTA without independent comparisons.

- [ ] Research behavior recovery: deploy matching server/worker and Browser Runtime application code from the [2026-11-10 plan](agent-behavior-improvement-plan-2026-11-10.md). Verify same-URL citation repair with exact exposure/ownership fences, fresh multilingual native search controls, and real-guest navigation/load deadlines without automatic retries or lost unknown-effect handling. No migration or guest/browser binary rebuild is required.
- [ ] Compare baseline/candidate research outcomes with fixed model/settings and repeated synthetic plus fresh held-out tasks. Review factual support, unresolved nationality/data-location evidence, conflicting dates, Chinese brief-phone language/progress/final delivery, latency and cost. Confirm the shorter page deadline does not materially regress legitimate slow sources. Source implementation and deterministic tests do not establish production quality improvement.

Existing owner-controlled CDP is the supported live-reading mode; see [deployment-guide.md](./deployment-guide.md) for endpoint/owner configuration and the opt-in local fixture check. Managed Chrome provisioning and enforced browser-network/privacy isolation remain deployment TODOs; they are not automatic fallbacks or current guarantees.

- [ ] Remote viewer rollout: build both pinned Zendriver patches into the guest image and Browser Runtime release, drain through the maintenance API, preserve user data volumes, and wake a fresh generation. Verify trusted HTML drag/drop, native slider dragging and immediate human clicks through the authenticated owner route. Record actual input/refresh latency on the deployed VM; command-count reductions and local Chrome fixtures do not establish a remote latency target.
- [ ] Viewer navigation/precision rollout: deploy matching action/frame DTO readers, Web and resident Browser Runtime adapter. Verify history (including empty history), new/switch/close tabs, blank-tab handoff, stale-target rejection after switching, and private tab metadata exclusion for other views/journals. Check Fit/50–400% magnification, local pan versus remote drag, mobile overflow and gesture cancellation. Existing patched MCP binaries suffice; full desktop capture/input remains undelivered.
- [ ] Host-reboot recovery: verify upstream proxy recovery also restores dependent DNS, environment networking reconstruction happens automatically on start without replacing user disks (local owner-route validation passed; the explicit repair script remains for ambiguous failures), Node Agent startup reconciliation converges stale durable state with real unit state, and guest RPC/browser frames work after wake. Remaining production gates: storage-encryption attestation and deployed-isolation validation; automatic reconstruction covers networking and state convergence only.
- [ ] Shared browser rollout: deploy matching contracts/DB record readers and Browser Runtime writer. Verify Main/side/personal Work use one browser/profile, cross-chat control exclusion and handoff, source access revocation before input, per-origin command/evidence authority, and side-close lifetime. Local owner-route Main/two-side handoff and one active browser were verified; production authorization and isolation gates remain separate.

  Local development evidence (2026-10-26): both disposable guest generations and authenticated owner-route native input checks passed after a drained-node image release. Five frame requests measured 179ms median; clicks with capture measured 225–234ms. Production rollout and its latency/isolation gates remain unchecked.

## Main context rollout gate (opt-in implementation, 2026-11-03)

Applies when enabling [cache-aware context segments](main-chat-context-plan.md),
with `CONTEXT_SEGMENTS_ENABLED=true` (Helm `config.contextSegmentsEnabled`).
The default is false; no deployment was changed by the source implementation.

- [ ] Compatible event readers deployed before writers; restart/torn-tail replay,
      expected-revision concurrency and old-log fallback verified.
- [ ] Stable prefix and deliberate rebuild fixtures pass; completed-turn filtering,
      output reserve, exact private manifests and failed-checkpoint recovery retained.
- [ ] Correction, removal, forgetting, source exclusions and owner/team/child policy
      fences invalidate stale inputs before the next dispatch/effect.
- [ ] Provider trials distinguish reported cache hits from estimated common prefixes;
      compare total task cost including compaction/retrieval and unavailable prices,
      cold/warm/expired caches, latency, recall and topic contamination.
- [ ] Main date separators pass midnight/DST, spanning-turn, timezone, pagination,
      streaming and draft/focus checks plus desktop/mobile agent-browser inspection.
      No midnight model reset or daily-digest dependency is introduced.

### Nightly review rollout

- [ ] Deploy migration 0022 and matching contracts, server, agent worker, control worker and Web.
- [ ] Enable existing scheduling infrastructure and explicitly create a nightly review in Scheduled tasks; verify previous-local-day date, DST behavior, one Updates outcome and missed/overlap skips.
- [ ] Confirm account timezone across browsers; test storage failure feedback and no Main/context reset.
- [ ] Evaluate real-model digest coverage, topic grouping, contradiction proposals and poisoned/excluded/deleted source handling. Deterministic fixtures do not establish memory quality.
- [ ] Confirm nightly Persona writes are rejected and review outputs are not indexed as source conversations. Review proposals manually in Memory settings.

Nightly catch-up rollout additionally requires migration 0023 and replacing old control-worker writers (no mixed-version scheduler writers). Verify restart after a multi-day outage, original review dates, queued-work deduplication, seven-local-day expiry, safe retry backoff/caps, cancellation, changed permissions and pause/resume boundaries. Confirm Updates shows expired gaps, attempts and retry times; ordinary missed schedules must still skip.

Browser extraction coverage recovery: deploy matching optional-metadata readers/writers and refreshed browser skill. Preserve embedded-content privacy exclusions. Frame-aware extraction, authenticated asset export, reproduction of the reported public page and real-model recovery acceptance remain open; advisory guidance is not an enforced ban on shell networking.

2026-11-13 extraction/export follow-up supersedes the preceding undelivered status for readable same-origin frames and saved Markdown export. Fixed extraction recursively reads up to 20 visible frames per document and three levels, applying embedded-document privacy checks and global artifact/block bounds. Cross-origin/inaccessible frames, shadow roots and canvas text remain unsupported. Observed image URLs and bounded already-decoded PNG pixels are retained in immutable blocks. No fetch, CORS override, driver switch or private endpoint access is added. `browser export_markdown` uses an authorized intact observation and ordinary Sandbox workspace mutation to create a generated filename, retaining heading levels, tables, code and images. Coverage remains unverified; unavailable pixels retain explicitly reported remote references. Deploy matching contract/core readers before writers. Public-site reproduction, cross-origin frame support and real-model behavior acceptance remain open; these local fixtures do not establish universal complete export or enforce an unconditional network-command ban.

### Visible embedded-content recovery (2026-11-13)

The semantic extractor and privacy checks now traverse bounded open shadow roots. Managed Zendriver selects visible embedded documents from adapter-owned frame metadata, checks every selected frame for protected controls, evaluates fixed extraction in an isolated context and revalidates the frame tree before returning evidence. Ambiguous duplicate frame URLs, hidden embeds, credential URLs and changed frame identity fail closed or remain unread; frame IDs never become model input targets. Scoped reads do not bypass frame privacy. Captures retain existing artifact/block bounds and saved Markdown export. Closed shadow roots and canvas-only text remain unavailable.

Real Chrome testing exposed an incomplete Zendriver event frame registry: a rendered iframe may be absent even after document load completes. The tracked `zendriver-mcp-frame-read.patch` reads Chrome's authoritative frame tree and supplies isolated frame evaluation when the event registry missed the frame. Build and deploy the matching binary with the updated TypeScript runtime. Firecracker requires a guest-rootfs rebuild and fresh generation through existing maintenance gates, preserving data/profile disks; no production runtime has been upgraded by the implementation task. The patch does not bypass CORS, disable browser security or add an HTTP transport.

Verification: backend suite passes 1,330 tests (27 opt-in tests skipped); workspace typecheck and lint pass. The patched pinned Rust executable builds successfully. The full opt-in real Chrome suite passes all 15 tests, including the reported public page: 253 blocks, 18,134 text characters, one resolved embedded frame and no capture truncation. The extractor detected zero `img` blocks on this page; this does not certify absence of other visual content. No curl or repeated navigation to that page was used by the successful reproduction. This validates browser extraction, not real-model action selection or universal website completeness. Production/guest rollout remains an operator maintenance action; current running services and VMs were not upgraded.

### 2026-11-14 export/copy acceptance

- [ ] Deploy matching readers/writers for optional export diagnostics and operation-specific task checks.
- [x] Configured running guest copy acceptance: Unicode, exclusive creation, existing/raced targets, symlink rejection and cancellation passed. Explicit policy restrictions/no fallback are also covered deterministically. No worker deployment is implied.
- [ ] Run a fixed-model export task with inline SVG, raster media and embedded content; assess readable output, language, approvals and justified call counts.
- [x] Compared the original saved graph, HTML and exact-hash conversion input: CSS grid block spans caused concatenation. Retained inert grid HTML fixes the demonstrated output; viewer compatibility remains qualified.
- [x] Resource-specific read/copy/export eligibility and bounded structured rejection diagnostics implemented and replay-tested. Adapters without known resource metadata retain conservative handling.

Two-repeat synthetic real-model export acceptance passed twice (four trials); this does not close the full live-browser/model/guest export gate. See [acceptance evidence](export-verification-acceptance-2026-11-14.md).

### Operational personal memory and scheduling (2026-11-15)

- [x] Matching local server/worker/control-worker/Web deployed; scheduler included in
      full deployment and saved-container lifecycle operations, with reconciliation health.
- [x] Guarded originating Persona save/refresh and child-write denial regressions.
- [x] Transactional nightly source, owner, setting, revision, removal/exclusion and
      suppression checks; verbatim bounded direct declarations; proposals for unsupported
      wording/contradictions; no automatic retry after Persona calls.
- [x] Explicit text-only nightly reads and denied-skill catalog omission avoid guest
      allocation/missing historical media dependencies; ordinary recall media retained.
- [x] Final configured-model isolated save/recall/correct/forget acceptance passed;
      actual account grouped digest completed, supported profile restored at revision 3,
      daily 03:00 Asia/Hong_Kong schedule enabled; UI versions/sources inspected.
- [ ] Broader multilingual/semantic extraction and grouping-quality evaluation.
      English/Chinese nightly admission is conservative; lexical History labels and
      bounded model-generated digest groups do not establish semantic clustering or
      exhaustive source coverage. This local rollout does not establish production isolation.

### Active-task Steering rollout

- [ ] Deploy readers supporting `steering/accepted`, `steering/applied` and bounded supplemental context receipts before updated server/worker writers and Web.
- [ ] Exercise real-model correction, incidental-question continuation, approval waits and exhausted budgets with an active task.
- [ ] Exercise multi-worker recovery after admission/application and completion races; confirm one final result and no repeated uncertain effects.
- [ ] Verify Main queue vs Steering, side Chat/Work supplements, reconnect/pagination, attachments and Stop on desktop/mobile. No migration or guest image update is required.

See the [Steering specification](in-flight-steering-gap-analysis.md#9-implementation-specification-and-delivered-scope) for source scope and limitations.

- [ ] Deploy the composer model/reasoning picker refinement (2026-11-17) and verify new Chat/Work, Main and reopened conversations with authenticated Member/Expert/Admin accounts. Confirm first-prompt selection, explicit Apply, supported reasoning controls and mobile fit. Local UI fixtures do not establish live-provider acceptance.

- [ ] Verify the simplified model picker has no numeric budgets, output limits or advanced controls; named effort choices appear only on supported integrations. Confirm Apply clears legacy hidden tuning.

- [x] Deploy the 2026-11-18 unbound-conversation routing repair locally with matching server/worker/client. All six Podman services run, API/control-worker health checks pass, and deployed server/worker hashes match. Deterministic tests verify historical usage/default binding, explicit/legacy selections and Apply after chat sequence changes.
- [ ] Confirm an authenticated existing conversation completes a real MiniMax response after the routing repair; local deployment health and fake-provider tests do not establish provider acceptance.

- [x] Diagnose the latest MiniMax HTTP 400 turns, correct invalid prefixed upstream IDs through audited configuration, and pass a real quota-metered constrained-SDK synthetic test (2026-11-18).
- [x] Deploy the MiniMax model-ID write validation/editor hint and safe actionable HTTP 400 message; all six services run and API/control-worker health checks pass (2026-11-18). Tests preserve custom gateway namespaced IDs and historical configuration/event reads.

- [x] Deploy the K3 object-union schema/known model metadata repair (2026-11-18). All six services and API/control-worker health checks pass; deployed server/worker exporter hashes match. Both models passed full 17-tool quota-metered tests during diagnosis; deployed registry output verifies explicit object roots. No-tools tests alone do not establish ordinary chat readiness.
- [ ] Confirm normal post-deployment Chat turn completion for K3 and MiniMax Flash. Immediate repeat probes were blocked before dispatch by the existing ten-probes-per-hour limit; no new user turn had arrived at the final check.

- [x] Apply the Firecracker proxy tunnel ownership fix on the local host. Verified the unmanaged tunnel, restored routes, guest DNS and public HTTPS on the running assignment.
- [x] Correct semantic extraction under `display: contents`. Verified typed Google Search evidence on the assigned guest and the running Browser Runtime's updated source and health.
- [ ] Verify the tunnel remains unmanaged and retains both routes through a host suspend/resume cycle. The immediate browser recreation check after handoff also remains open.

- [x] Specify and implement the glass material UI in product requirements and design §11.5. Pass frontend regressions, lint, frontend typecheck and production build. Inspect desktop/mobile React layouts using local mocked APIs, including retained composer draft and sidebar toggling (2026-11-23).
- [ ] Deploy and accept the glass UI in an authenticated environment. Verify reduced transparency, increased contrast, forced colors, unsupported-filter fallback and scrolling performance on real mobile devices.

- [x] Implement the glass styling revision: neutral canvas, consistent radius roles, unified composer/action grid, compact expandable header and collapsed mobile gutter correction. Pass 334 frontend tests, lint, frontend typecheck/build and inspect mocked desktop/mobile layouts at five viewport widths (2026-11-23).
- [ ] Deploy the styling revision and visually accept populated/streaming conversations, attachments, approvals, settings and voice mode in an authenticated environment. Measure composited contrast and check accessibility fallbacks plus real-phone keyboard/safe areas. The initial glass-pass captures and automated checks do not close these gates.

- [x] Implement the Soft Glass visual strategy across Login/Main, replacing the flat neutral revision: luminous backdrop, frosted inset navigation, raised composer/login, coherent icons/type/radii and 780px reading width. Pass 334 frontend tests, lint, frontend typecheck/build; inspect empty/populated desktop/mobile fixtures and draft preservation across five viewport widths (2026-11-23).
- [ ] Deploy and accept Soft Glass with authenticated sessions. Check Safari, real-phone keyboard/safe areas, composited contrast, accessibility/fallback modes and populated attachments/approvals/voice surfaces. Local Chromium and mocked ACP captures do not establish those results.
