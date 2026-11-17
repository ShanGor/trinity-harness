# Roles, LLM configuration and outage recovery improvement plan — 2026-11-17

Status: control-plane, role migration, manual/no-output routing and shared health/probe mechanisms implemented in the checkout. Production deployment and operational acceptance remain pending. See [operations and cutover](llm-configuration-operations.md), [project progress](project-progress.md) and [release gates](production-checklist.md). This implementation task does not activate a live tenant or authorize paid-provider testing or Git operations.

## 1. Objective and design authority

Allow a tenant administrator to configure LLM connections and switch an affected routing profile to a prepared backup from the web application without editing `.env` or restarting services. Ordinary Members receive a complete assistant; Experts receive bounded session controls; Admins manage shared configuration. Preserve Viewer as read-only and preserve execution authorization, tenant isolation, replay and usage accounting during outages and role changes.

Requirements: [personal assistant §14](refactor-as-personal-assistant.md#14-roles-and-web-managed-llm-configuration-2026-11-17-requirements). Architecture: [design §5.4](design.md#54-tenant-llm-configuration-and-routing-2026-11-17-target-design) and [§12.1](design.md#121-account-roles-and-authorization-migration-2026-11-17-target). Recovery and request context remain governed by [intent-execution-design.md](intent-execution-design.md), design §6–7 and [usage-accounting.md](usage-accounting.md). Packaging follows [deployment-guide.md](deployment-guide.md).

## 2. Inspected baseline and gaps

This is a source-checkout assessment, not an inspection of the running deployment. Unrelated in-progress changes were present and are outside this plan.

| Area                      | Inspected baseline                                                                                                                                | Required change                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Provider access           | `packages/core/src/llm/ai-sdk-gateway.ts` builds Anthropic/OpenAI factories from process environment; custom base URLs share those protocol slots | Named tenant connections and deployment resolution through the existing SDK gateway      |
| Runtime composition       | Server/worker env schemas and roots configure model, reasoning, context/output and compaction at startup                                          | One authoritative published configuration read by both roots at request boundaries       |
| Identity                  | `packages/contracts/src/identity.ts` has `admin/developer/viewer`; `packages/db/src/schema.ts` defaults account role to `developer`               | `admin/expert/member/viewer`, explicit capability checks and compatible migration        |
| Distributed authorization | Role checks occur in server, worker, Node Agent, memory, schedules and stores; some internal identities use literal `developer`                   | Audit all role producers/consumers, preserving authenticated identity and existing scope |
| Authentication            | `packages/core/src/auth/token-service.ts` signs a role claim                                                                                      | Current role checks and a bounded legacy-token transition                                |
| Sessions                  | Session settings exposed policy controls; requests used startup model settings without a tenant connection registry                               | Explicit profile binding versus pinned-deployment semantics and historical compatibility |
| Recovery                  | Loop owns bounded persisted retry timing; SDK retries disabled; partial responses have continuation behavior                                      | Eligible ordered fallbacks within the same recovery scheduler and budgets                |
| Accounting                | Fixed `config/models.yaml` loaded by both roots; per-request usage/rate snapshots                                                                 | Actual deployment attribution and explicit catalog mapping, preserving historical prices |

Do not implement by editing `.env` from HTTP, mutating global `process.env`, adding frontend provider calls or adding another retry layer. A provider protocol name is not a unique vendor, endpoint, model or billing identity.

## 3. Accepted product decisions

### 3.1 Roles

The primary hierarchy is **Admin > Expert > Member**; Member is the agreed Normal tier's display name. Viewer is a separate restricted role. Canonical stored values are lowercase. New ordinary accounts default to Member.

| Operation                                                      | Member | Expert | Admin | Viewer       |
| -------------------------------------------------------------- | ------ | ------ | ----- | ------------ |
| Run ordinary assistant tasks with tools/approvals              | Yes    | Yes    | Yes   | No           |
| Select an approved profile                                     | Yes    | Yes    | Yes   | No           |
| Use published automatic fallback                               | Yes    | Yes    | Yes   | No execution |
| Adjust bounded session reasoning/output settings               | No     | Yes    | Yes   | No           |
| Reorder permitted session backups or pin an allowed deployment | No     | Yes    | Yes   | No           |
| Manage tenant endpoints, secret replacement and deployments    | No     | No     | Yes   | No           |
| Publish defaults/routing, emergency switches and rollback      | No     | No     | Yes   | No           |
| Manage tenant users/roles/quotas and configuration audit       | No     | No     | Yes   | No           |
| Inspect actual model usage on an accessible conversation       | Yes    | Yes    | Yes   | Yes          |
| Read back a stored secret                                      | No     | No     | No    | No           |

Keep a small explicit capability mapping rather than a configurable role builder. Suggested internal capability names are `assistant.run`, `llm.profile.select`, `llm.session.tune`, `llm.configuration.manage` and `tenant.users.manage`; finalize names with the contracts patch. Capabilities remain bounded by tenant/session access and policy. Do not infer all permissions from role order or expand existing administrative data access as part of this work. Team roles remain independent.

Migrate Developer to Member, retain Admin and Viewer, and require an explicit Admin assignment for Expert. Preserve current account features such as personal memory and schedules for Members. An account downgrade must fence future work, including queued prompts, schedules, children and Expert-only overrides; do not restart already executed tools. Rejection identifies the required user action without leaking protected configuration. Protect the final usable tenant Admin against accidental removal/demotion using a transactional invariant.

### 3.2 Objects and lifecycle

| Object               | Required content                                                                                                                               | Lifecycle                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Connection           | Tenant ID, stable ID, name, supported adapter, normalized endpoint, credential reference, administrative availability                          | Draft, publish, disable/retire; observed health is separate                             |
| Credential version   | Tenant/connection binding, ciphertext or secret-manager reference, encryption key/version metadata, replacement/revocation metadata            | Write-only creation/replacement; explicit revocation; never returned in plaintext       |
| Deployment           | Stable ID, connection ID, upstream model ID, context/output limits, declared capabilities, provider settings, pricing catalog key              | Published through a configuration revision; retire without deleting historical identity |
| Profile              | Stable ID/name, primary and ordered backups, manual/automatic/pinned mode, permitted destinations/deployments, tuning bounds, purpose bindings | Revisioned draft and atomic publication                                                 |
| Tenant configuration | Durable source mode, expected draft revision, active published revision, default profile                                                       | Reviewed import/activation; CAS publication and rollback as a new revision              |

Use immutable secret-free published snapshots. Mutable current availability/revocation remains authoritative and can veto a historical snapshot. All references must be tenant-bound; use relational constraints where practical and transactionally validate references within revision payloads. Deleting/retiring a profile must account for bound sessions; show affected bindings and require explicit reassignment or leave it unavailable. Do not silently remap sessions or delete historical configuration needed by receipts.

Proposed initial validation bounds: 64 connections, 256 deployments and 64 profiles per tenant; at most three backups per profile, no duplicate targets or recursive profile chains; names up to 100 characters, model IDs up to 256, endpoint URLs up to 2,048 and secret input up to 16 KiB. Bound the total revision payload and every provider setting through closed adapter-specific schemas. Final numeric bounds require validation against supported adapters during implementation; never accept arbitrary JSON headers/options as an escape hatch.

For billing, a deployment references an explicit fixed-catalog entry; separate billing arrangements require separate catalog keys even when upstream model IDs match. Do not key accounting solely by protocol/model. Unknown rates remain unavailable. Admin-editable rates, dynamic catalog downloads and currency conversion are outside this scope.

### 3.3 Sessions and request boundaries

- New sessions bind to the current default profile unless the user selects another permitted profile. Changing the tenant default does not migrate existing sessions.
- A bound profile follows new published revisions at the next model request. A pin remains on its deployment; it does not silently opt into fallback. Disabling that deployment blocks its next dispatch with an actionable result.
- Expert/Admin overrides are bounded to the profile's approved deployments, destination policy and parameter limits. A role downgrade or tighter admin bound makes a stale override invalid and requires reset; it is not silently grandfathered.
- A profile update/emergency switch affects future admitted requests. It does not cancel an active provider stream, interrupt a tool wave, rewrite a plan or restart a task. Disable/revocation does not recall data already sent.
- Compaction has an explicit approved purpose profile or inherits the originating profile. Children inherit the parent's authorized routing scope, not the ability to select arbitrary connections. Route admission never replaces a summarizer's purpose-specific messages with assistant context.
- Commit user session selection/override changes as additive session events with authenticated access, expected sequence and idempotency handling. Preserve historical model fields/events and account for existing explicitly selected models during migration.

## 4. Architecture and storage work

Extend existing modules rather than adding a service or plugin framework. Implement proposed `LlmConfigurationPort`, `LlmRoutingPort` and `LlmCredentialPort` in contracts with Zod DTOs; public redacted shapes are re-exported through shared. Keep provider SDK calls inside `AiSdkGateway`; create SDK provider instances from resolved immutable connection settings rather than process-global changes. Resolve at each dispatch so old per-workspace service caches cannot pin stale settings.

PostgreSQL owns configuration, revisions, source activation, credential metadata and durable administrative audit intent. Proposed schema groups are tenant configuration/current draft, immutable configuration revisions, connection credential versions/current revocations and a configuration audit outbox. These extend existing Identity/LLM/database responsibilities. Use Drizzle schema → generate → SQL review → migrate. Choose normalized reference columns versus bounded revision payloads in the schema review; tenant foreign-key/reference validation and atomic publication are mandatory either way.

Publication uses expected revision plus tenant-scoped idempotency key. Publish, source activation and audit/outbox intent commit together; lost responses can be retried without publishing twice. The existing audit pipeline consumes durable intent idempotently. Audit records retain actor, action, safe field differences, target/revision, reason and outcome, with no secret payload or raw provider response. A durable outbox prevents a Redis interruption from losing an accepted configuration change's audit record.

Before every model dispatch, resolve the authoritative active revision and current role, availability, destination policy and secret authorization. Cache immutable configuration by revision only. Redis notifications speed refresh; missing notifications must not keep a worker on stale configuration. Read failure denies new dispatch. Define the final authorization check as the admission boundary: changes committed after admission cannot atomically undo an external request already being sent. No distributed exactly-once provider guarantee is claimed.

Persist an additive secret-free routing receipt before dispatch: originating prompt/request IDs, purpose, configuration/profile revision, connection/deployment/model IDs, credential-version identifier (never secret), selected settings/limits, decision reason and pricing reference. Persist attempt/fallback scheduling in the existing recovery projection. Receipt write failure prevents dispatch. Restart revalidates current authorization/revocation and uses existing uncertain-request recovery rules rather than blindly resending a receipt. Preserve torn-tail handling and complete tool pairs.

Route metadata is replayable via typed ACP metadata and existing client projections; ordinary users receive a safe profile/model label and reason, not endpoint URLs or credentials. Keep full administrative details on permission-checked REST routes. Historical receipt IDs do not grant access to current provider configuration.

## 5. API and frontend work

These are proposed route families, to be finalized alongside shared Zod contracts; no API in this table exists by virtue of this document.

| Surface                                      | Operations and enforcement                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/admin/llm/configuration`               | Read redacted draft/current revisions; expected-revision draft save; Admin + tenant scope      |
| `/api/admin/llm/connections/:id/credentials` | Write-only replace/revoke with idempotency and revision checks; no secret GET                  |
| `/api/admin/llm/connections/:id/test`        | Bounded synthetic SDK request, rate/concurrency limits, cancellation and safe result           |
| `/api/admin/llm/configuration/publish`       | Validated atomic publication and impact preview binding to exact revision                      |
| `/api/admin/llm/configuration/rollback`      | Publish validated prior content as a new revision; current revocation still wins               |
| `/api/admin/llm/activity`                    | Bounded configuration audit, test/health timestamps and safe error classifications             |
| `/api/llm/profiles`                          | Redacted approved catalog for the current user's capabilities; no connection secrets           |
| Session model settings route                 | Additive profile selection or bounded Expert override for an authorized session; Viewer denied |

Use the existing client package for HTTP transport and error handling. Return explicit unauthenticated/forbidden, unavailable, validation, revision-conflict and stale-override outcomes. An old client submitting arbitrary model strings cannot bypass profile allowlists after database activation; unresolved legacy selections return migration guidance. Every server path authorizes independently of hidden UI controls.

Account → Administration → AI configuration contains:

1. **Connections:** connection/model setup, synthetic Test, write-only Replace key, disable/retire and separate last-test/observed-health information. Changing endpoint or model invalidates earlier test relevance.
2. **Routing:** profile primary/backups, mode, bounds, destination consent, draft/published revision and tenant default. Emergency Use backup reuses validated publication with the affected profiles and application boundary shown. Restore primary is explicit initially.
3. **Activity:** timestamped publication/rollback/role-relevant audit and safe test/fallback/error information. Missing observations are Unknown. Retain current metrics privacy rules; tenant/user/session/endpoint details are not metric labels.

Members see approved profile choices with understandable names and defaults. Experts/Admins additionally see Advanced settings and limits. Tests state that they send synthetic data and may incur charges; record spend separately from user-session totals while still enforcing applicable tenant quotas. A passing test proves only the exercised capabilities at that time, not production health or semantic model quality.

Keep settings state separate from the transcript and composer. Opening, editing or rejecting settings changes must preserve drafts, textarea identity/focus, stable history references and active streams. Use existing ACP recovery for execution metadata rather than a component-owned EventSource.

## 6. Secret and endpoint security

Use deployment-managed envelope encryption or an external secret manager. The master key/key reference remains an infrastructure secret, outside the database, browser, workspace, guest and session events. Bind ciphertext to tenant/connection/version, retain key IDs for controlled rotation and fail closed on decryption/key-service errors. Do not add a plaintext development fallback to the management API.

Secrets enter only through authenticated encrypted transport and bounded write requests. Suppress request-body tracing, frontend persistence, form analytics and raw SDK/error logging on these routes. Responses expose configured status and replacement metadata only. Draft diffs, audit, exports, exact model-context artifacts and test output must not contain credentials. Retiring a connection prevents new resolutions; credential revocation cannot be undone by configuration rollback. Retention/deletion and backup handling need an operator-reviewed policy before production, including destruction of obsolete credential versions when allowed.

Operator policy governs allowed provider destinations. Validate schemes, length, ports, URL credentials, DNS results, actual connect targets and redirect behavior; block private/reserved/metadata/control destinations by default. An explicit internal gateway exception must be operator-configured and scoped. Tenant Admin cannot authorize arbitrary host-network access. Endpoint tests and inference share the same constrained SDK transport. Do not reuse guest/browser egress settings as proof of provider-path enforcement, perform discovery fetches through unvalidated endpoints or accept arbitrary request headers.

## 7. Recovery behavior

Start with manual switching, then add automatic failover for compatible model requests producing **no text, reasoning or tool-call output**. SDK retries stay disabled. The existing Loop owns one bounded attempt schedule spanning retries and fallbacks; profile size is not an additional retry allowance. Persist attempted routes, reason, ordinal and pending retry time. Preserve current task reservations/deadline, cancellation and provider timing across replay.

In automatic mode, after an eligible no-output failure, prefer the next untried, currently eligible deployment in published order before waiting to retry the failed route. Only when no alternate is ready may the existing scheduler wait/retry within its remaining allowance. Track this order per logical model request and persist it across recovery; a new backup must not reset the current request's recovery count. This provides fast failover without stacking three retries on every connection. Manual and pinned modes never traverse backups automatically.

| Outcome                                                                  | Action                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Transient connection, overload, retryable server error                   | Existing bounded retry or next eligible approved backup; no tool replay                                                 |
| Rate limit                                                               | Respect affected connection/deployment Retry-After; another independently eligible route may be used                    |
| Invalid credential, disabled account, permanent balance/quota exhaustion | Do not retry that failing connection; surface attention-needed state and consider only approved independent backups     |
| Invalid arguments, unsupported input/tool capability                     | Reject or select an explicitly compatible candidate; do not cycle blindly                                               |
| Context too large                                                        | Apply existing safe context handling for the target or exclude it; never truncate required instructions/inputs silently |
| Cancellation, authorization/policy denial, safety refusal                | No outage fallback                                                                                                      |
| Any partial output                                                       | Preserve existing bounded same-deployment continuation; cross-deployment recovery deferred                              |
| Failed stream containing unfinished tool calls                           | Execute none of those calls; preserve failure/recovery provenance                                                       |

Eligibility checks actual request capabilities and data destinations, not just configured model names. Validate reasoning signatures/history format across candidate connections; incompatible active history makes a candidate ineligible until the existing context path can safely represent it. Do not strip signed reasoning ad hoc to force compatibility. Re-estimate input/output, check context, reset model-specific calibration and reserve known costs for each actual dispatch. A fallback with unknown required prices is ineligible under a configured cost ceiling. Existing successful tool results and unknown-effect fences survive a model change.

Later, add shared circuit breaking with state keyed by connection/deployment and failure category: closed/open/half-open, expiring evidence and a bounded probe lease in Redis or PostgreSQL. Avoid process-local health deciding routing across replicas. Credential errors apply to the credential/connection; a model-specific error must not disable unrelated models. Missing health storage must not imply Healthy or bypass the authoritative configuration check. Only observed bounded synthetic probes can restore automatic eligibility; manual restore remains available with clear test age. Define numerical thresholds from measured failure/latency behavior in that phase, rather than asserting an untested availability guarantee now.

## 8. Delivery sequence and migration

### Phase A — Roles and compatible readers

1. Inventory every role schema/default, token issuer/decoder, API/user form, worker/scheduler/Node Agent gate, store and internal identity producer, including tests and deployment bootstrap scripts. Distinguish account `member` from team `member` and DOM accessibility roles.
2. Introduce canonical roles and the explicit capability matrix with server-authoritative current-role checks. Temporarily normalize legacy `developer` to Member; do not rewrite historical session/audit actor records. Preserve restricted Viewer and account feature availability.
3. Deploy compatible readers to all participating services before writers can emit Expert/Member. Retire old writers and drain incompatible execution. Change defaults and migrate account rows through a reviewed Drizzle migration; avoid a rolling mix that reintroduces Developer defaults.
4. Require token refresh/relogin for changed roles and bound the legacy-claim window to the existing token lifetime. Validate current roles for protected operations regardless of claim age. Unknown claims fail closed. After the transition, stop accepting legacy values for new user writes/tokens while retaining historical decoders.

Exit: permission matrix, downgrade/stale-token, queued work and Viewer regressions pass across inline/distributed execution. No account gains Expert implicitly. Reverting to an old binary after new roles are written is not supported.

### Phase B — Configuration, secrets and manual recovery

1. Add reviewed storage/ports, encryption integration, endpoint policy, durable audit intent, synthetic tests, draft/publication/rollback APIs and administration UI. Add ordinary profile selection and bounded Expert settings.
2. Extend gateway/request accounting and route receipts in both composition roots. Include compaction/child calls and remove startup-cached environment decisions from database-managed dispatch.
3. An operator explicitly binds any environment-secret import to an authorized tenant; the tenant management API must not let an Admin claim deployment-wide environment keys. Import a reviewed tenant draft. Reconcile every existing session model: preserve its selection with an approved deployment binding where resolvable; otherwise report unresolved and block activation or that binding until resolved. Never guess which connection owned an ambiguous model.
4. Publish/activate the database configuration source transactionally. Environment mode remains available only before activation and in existing unauthenticated/no-PG static development. It exposes no management API. After activation, missing PG/configuration/key service denies new dispatch; never switch back automatically.
5. Verify switching a prepared profile to backup without process restart, including missed Redis invalidation, concurrent edits and pinned sessions. Restore through a new revision that still respects current credential revocations.

Exit: an Admin can recover routing manually from the UI while concurrent sessions/tools remain intact; safe receipts, role checks and actual usage attribution are replayable. No database activation is performed by this documentation task.

### Phase C — Bounded automatic fallback

Extend the existing recovery projection/scheduler, eligibility and accounting tests for no-output failures. Publish automatic mode only after compatible readers understand the added events. Cover provider wait timing, retries/fallbacks sharing one budget, crash/restart and absence of tool replay. Leave cross-deployment partial-stream recovery unavailable.

Exit: scripted fake-provider failures recover to an eligible backup deterministically; incompatible/private/unpriced routes cannot be used and counters cannot reset after restart. Opt-in live-provider checks establish adapter behavior separately.

### Phase D — Shared health and operational acceptance

Add shared circuit breaking, bounded probes, safe operational views and measured thresholds. Exercise a controlled outage across multiple workers, restore and test credential rotation/revocation races. Assess actually independent failure domains and document observed recovery timing. Automatic failback requires separate measured acceptance; initial production operation can use explicit restore.

## 9. Verification matrix

| Area                   | Required evidence                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions            | Every role against each read/write route; direct HTTP bypass; cross-tenant IDs; team/session ownership; Expert inheritance without new private-data access; Viewer retains read-only                                                |
| Role migration         | Developer→Member; no Expert grants; default/unknown roles; last-Admin race; old/new token claims; downgrade before queued/child/summary/Node Agent work; no privileged override retention                                           |
| Configuration          | Transactional draft/publish/activation/rollback; concurrent CAS conflict; idempotent lost-response retry; audit outbox recovery; missed Redis message; disabled references and stale override                                       |
| Secrets/network        | No readback/log/event/export leak; encryption/rotation/revocation; wrong tenant/version/key; key-service outage; invalid/credential URLs; DNS rebinding/redirect/private destination rejection; explicit internal-gateway exception |
| Request routing        | Both roots, existing pins/new defaults, per-purpose compaction/children, capability/context/tool/attachment/history checks; current revocation at admission; receipt persistence failure prevents dispatch                          |
| Recovery/replay        | Transient/429/permanent/refusal/cancel cases; no-output versus reasoning/text/tool output; shared ceilings; Retry-After; restart at each reservation/receipt/schedule boundary; no incomplete or repeated tool effects              |
| Accounting             | Per-attempt actual deployment/model/rate, failed-stream available usage, missing rates/buckets, cost-ceiling rejection, synthetic-test usage separate from conversations, no duplicate replay/quota counting                        |
| UI                     | jsdom + fake ACP role controls, advanced bounds, publish impact/conflict/error/draft recovery, secret-field handling, stable composer/history/streams, mobile forms; CLI visual inspection per agent-browser skill                  |
| Distributed acceptance | Multiple server/workers, no stale cache after publication, tenant isolation, credential rotation during active work, controlled outage and explicit restore                                                                         |

Run relevant `pnpm test`, repository `pnpm lint` and `pnpm typecheck` for implementation patches, plus changed-file formatting. Documentation preparation needs only Markdown/links/whitespace review. Deterministic tests establish mechanism behavior; paid-provider, real-browser and production recovery claims require separate explicitly authorized acceptance. Record evidence and limitations rather than marking planned gates complete.

## 10. Scope limits and release conditions

No per-user bring-your-own-key, custom role designer, platform-superadmin UI, editable pricing, provider marketplace, arbitrary SDK code/headers, automatic model discovery, unapproved data transfer or cross-model partial-answer splicing. No unrelated browser/guest driver changes or new capability-enable flag. This plan does not change the tool approval strategy or provide exactly-once provider billing.

Release requires compatible readers/writers, reviewed migrations and backups, operator-managed encryption/endpoint policy, role/token transition evidence, shared configuration freshness, safe request receipts/recovery, quota/pricing checks and a rollback rehearsal using compatible binaries. Configuration rollback and application rollback are distinct: old binaries cannot safely run after new role/config writers activate. Maintain the environment before-source transition only as an explicit legacy state; do not advertise it as recovery after activation.

## 11. Implementation choices and remaining acceptance

- Migration `0024_high_satana.sql` contains the role data/default change, canonical role constraint, seven LLM tables, unique current-credential index and immutable-revision/operation/source fences. The implementation was exercised against isolated PostgreSQL, including an upgrade seeded with Admin/Developer/Viewer rows. It was not applied to the application database.
- Contracts define the configuration/routing/credential ports plus endpoint-policy and provider-operations ports. Existing DB/core modules implement them; both composition roots inject them. Session creation/settings and attempt/result receipts are additive events. Child attempt receipts are copied to the durable parent journal before dispatch.
- Envelope encryption wraps a random per-version AES-GCM data key with an operator-provisioned key ring. Operator HTTPS origin policy controls DNS/connect/redirect behavior. There is no arbitrary header/options interface or provider-side discovery request.
- Configuration and role writes insert their audit rows transactionally. Dispatch freshness reads PostgreSQL directly, so missed Redis notifications cannot retain stale configuration. Role changes require reauthentication; legacy claims remain bounded by their existing expiry and retirement of old issuers.
- Publication review reports current binding/pin/unbound counts under an expected configuration version. Existing used sessions without a managed binding require explicit profile selection rather than guessed historical migration. New HTTP/ACP sessions capture their default at creation. Retired profile bindings remain unavailable until reassigned.
- The initial shared circuit policy uses three transient failures within 60 seconds, with immediate credential-scoped blocking for recognized permanent errors. Explicit bounded probes restore unchanged published targets; no timed probe daemon or automatic failback is delivered. Threshold calibration and controlled production outage timing remain phase D acceptance.
- Deterministic tests cover secrets, network policy, direct API role bypass, publication/CAS/audit/revocation, current roles, last-Admin races, synthetic settlement, recovery ceilings/uncertain receipts, partial output, incomplete tool calls and durable child receipt failure. Browser fixtures inspect desktop/mobile forms and emergency switching without contacting providers. Final command results are recorded in project progress.
