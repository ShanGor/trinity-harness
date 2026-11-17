# Provider/model configuration revision — 2026-11-17

Status: direct provider/model configuration, atomic inline credential saves, default/fallback routing and session selection implemented in the checkout. The profile-generating quick-setup wrapper is removed. Deployment and live-provider acceptance remain pending. Requirements §14.2 and design §5.4 govern the replacement.

## 1. Reference and scope

OpenCode uses provider configuration/credentials and direct model selection. Relevant local sources: `ref/opencode/packages/core/src/config.ts`, `core/src/v1/config/provider.ts`, `core/src/credential.ts`, `schema/src/config.ts`, and `app/e2e/user-story/model-selection-flow.spec.ts`. References remain read-only; borrow ideas, not code. Retain Trinity tenant isolation, RBAC, encryption, endpoint policy, append-only history, accounting and durable retry budgets. Do not add a plugin framework or assume OpenCode defines our fallback behavior.

## 2. Provider operations

Introduce bounded shared Zod contracts for provider connect/update/disconnect, model catalog, default selection and fallback settings. Model references contain providerId/modelId. A server-owned idempotent connect operation saves validated provider metadata and encrypted credentials transactionally. Connecting requires no model/default/fallback. Separate write-only key changes from configuration output. Support multiple named provider accounts. Preserve expected-version conflicts and acknowledged-operation recovery without exposing internal revisions in normal forms.

## 3. Routing and session selection

Replace profile-dependent dispatch with default/explicit model selection plus optional Expert tuning/pin. The tenant default and ordered fallback references are direct settings. Automatic fallback starts off; enabling explicitly approves listed destinations. Preserve no-output-only failover, partial-stream fencing, shared cooldowns, budget reservations, actual route/price snapshots, cancellation and no replay of tools. Compaction/children inherit the authenticated origin's selection. Current catalog metadata remains authoritative; unsupported custom capabilities fail closed.

## 4. Product UI

AI settings: connection forms with inline API key fields and one Save action; provider cards with Edit / Disconnect / Test connection; default model picker; optional fallback list. Kimi Code China is a preset with its correct endpoint. Composer: searchable enabled models grouped by provider plus “Default · model”. Catalog models need no deployment form. Advanced settings contain custom endpoints/model metadata, bounded Expert parameters and audit history. Remove profile creation, profile picker, publication reasons and draft/revision controls from ordinary setup. Show stored/untested/tested states accurately; run paid tests only on explicit action. Preserve draft keys on rejected writes, clear after acknowledgement, and keep composer state/focus stable.

## 5. Migration and rollout

Inventory actual published profiles, session bindings, Expert overrides and approved destinations before defining the data transform. Add compatible readers and new selection events before new writers. The implementation deliberately requires explicit model/default selection for every profile-bound session after Admin conversion, including apparently simple profiles. This preserves old histories without guessing pinned/default/fallback intent. The Admin confirms replacing legacy routing; the UI shows affected sessions an actionable selection requirement. Never silently broaden destinations, change a pinned selection or discard bounds. Retain historical events/revisions/receipts unchanged. Reuse tenant DB source fencing; unavailable DB/secrets must never reactivate environment configuration. Rollout requires matching server/worker/client readers, backup and rehearsal; rollback needs compatible binaries. Do not delete old data before migration acceptance. No live deployment is authorized by this document change.

## 6. Acceptance

- Save a Kimi Code provider key with no model/default and receive a meaningful acknowledgement.
- Select two models from one provider without creating two credentials or profiles.
- Default-following sessions adopt a changed default; explicit and pinned selections preserve their intent.
- Recover lost acknowledgements, key-write failures and concurrent edits without duplicates, leaked keys or false success.
- Member direct API writes fail; Expert overrides stay bounded; Viewer remains read-only; tenant boundaries and last-Admin checks remain intact.
- Approved compatible no-output fallback works across workers under durable budgets/cooldowns; partial output/refusal/cancellation/tool uncertainty never grants cross-model replay.
- Rehearse legacy migration with multiple profiles, conflicting rules, disabled providers, revoked credentials and replayed historical sessions.
- Verify composer focus/drafts, mobile layout, key entry and provider/model selection using fake ACP and browser fixtures; retain separate live-provider acceptance gates.

Record delivery evidence in project-progress.md and production-checklist.md. The prior implementation's passing tests do not establish this revised mechanism.

## 7. Delivered mechanisms

- Shared direct provider/model/default/fallback DTOs and typed client APIs; legacy schemas remain historical readers, not generated storage.
- One `/api/admin/llm/providers` PUT commits connection details, inline encrypted keys, current settings and audit atomically under tenant CAS/idempotency and current-Admin locks. No model/default is required to connect.
- Default/explicit model selection flows through replayable settings events, request preparation, compaction and children. Existing no-output fallback/cooldowns/usage reservations remain authoritative.
- AI settings now contain connection cards with inline keys, multiple models per connection, default/fallback pickers, model test/history and role controls. Composer and session settings use direct models.
- No SQL schema change: existing JSON snapshots store the direct routing shape. Matching readers are required before writers; pre-change binaries cannot read new snapshots. No live configuration was migrated or deployed by this task.

## 8. Connection CRUD refinement

Show a saved connection list with clear row boundaries and explicit Add/Edit/Delete actions. The list never contains editable credential/model fields. Add/Edit opens a focused connection form with inline key and endpoint, optional model details, Save connection and Cancel. Cancelling never creates a row or persists a secret. Default/fallback settings have a separate Save model settings action. Deletion explicitly clears references to the removed connection. Validate mobile list/actions and modal layout, independent editing, deletion and discard behavior. Endpoint-policy errors identify the connection and safe HTTPS origin without echoing full URLs/secrets; shipped China Kimi Code and MiniMax presets must be covered by default policy tests.
