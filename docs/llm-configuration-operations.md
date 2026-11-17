# Operating tenant LLM configuration

The checkout implements Admin / Expert / Member / Viewer and tenant-managed provider routing. Deployment and real-provider outage acceptance remain release gates. This runbook describes the required cutover; the implementation task does not deploy services or activate a live tenant.

## Infrastructure setup

PostgreSQL, authenticated accounts and matching server/worker binaries are required. Local unauthenticated mode retains static environment configuration and exposes no provider management authority.

Configure the following on both server and worker through the deployment's private environment or secret delivery:

```dotenv
LLM_CREDENTIAL_KEY_ID=v1
LLM_CREDENTIAL_KEYS={"v1":"<canonical-base64-encoded-32-byte-key>"}
LLM_PROVIDER_DESTINATIONS=[{"origin":"https://api.openai.com"},{"origin":"https://api.anthropic.com"},{"origin":"https://api.kimi.com"},{"origin":"https://api.minimax.cn"}]
```

Provision a cryptographically random 32-byte wrapping key through the operator's secret-management process. Never put its actual value in a ticket, repository or browser. The JSON key ring supports retaining previous key IDs while new replacements use the current ID. Preserve every wrapping key still required to decrypt retained credential versions. Rotate provider credentials by editing the inline key field; retire old wrapping keys only after reviewing all dependent versions and backups. Encryption uses a random AES-256-GCM data key for each version, wrapped by the infrastructure key; tenant, connection and version are authenticated in both layers.

The default destination policy permits the public HTTPS origins above, including China Kimi Code at `api.kimi.com` and MiniMax China at `api.minimax.cn`. An explicit `LLM_PROVIDER_DESTINATIONS` replaces these defaults; add any needed preset origins to that list. Kimi Code uses the subscription entitlement; Moonshot Open Platform at `api.moonshot.cn` is a separate pay-as-you-go API and is not the endpoint for this subscription. Add other provider origins explicitly, including the exact port. A private gateway requires an explicit operator rule such as `{"origin":"https://gateway.example:8443","allowPrivate":true}`. This authorizes only that origin; TLS verification still applies. Admins cannot modify this infrastructure policy through the UI. Configuration writes validate origin/scheme policy without requiring live DNS, so a provider DNS outage cannot block emergency publication. Tests and inference use fresh bounded DNS checks, a pinned validated connect address, no redirects and no ambient proxy inheritance through the same SDK transport. Guest/browser egress settings are independent.

Missing encryption keys block credential writes/decryption. Missing authoritative configuration, revocation or shared health storage blocks managed dispatch. No plaintext management fallback is provided.

## China Kimi Code subscription

For a China-region Kimi membership, create an API key in the Kimi Code Console and add it as a connection credential in Administration. Keep the key private; the app stores it write-only and encrypted. Configure the connection as:

- Protocol: OpenAI compatible
- Endpoint: `https://api.kimi.com/coding/v1`
- Model ID: `k3-256k` for the 256K-context variant, or `k3` if your membership tier grants the larger context. Confirm model access in the Kimi Code Console.
- Capabilities: enable tools and reasoning only when supported by the chosen model; Kimi Code requires thinking.

The endpoint and model IDs above are from [Kimi's official Kimi Code membership guide](https://www.kimi.com/en/help/kimi-code/membership-guide). Do not use `api.kimi.ai` (overseas Kimi Code), `api.moonshot.cn/v1` (Open Platform billing), or an Open Platform key for this subscription. Membership quota/rate limits are enforced by Kimi. Configure the app's pricing key only if its fixed catalog contains the applicable accounting rate; otherwise usage cost is displayed as unavailable and cost ceilings cannot use it.

## Role and schema cutover

1. Back up PostgreSQL and the private key material. Review migration `packages/db/migrations/0024_high_satana.sql` and the matching schema snapshot.
2. Drain incompatible execution and stop old writers across server, agent worker, control worker and Node Agent. This patch requires a coordinated maintenance cutover. A rolling deployment would require a separate compatible-reader release first; do not mix old role readers with new writers.
3. Apply the reviewed migration using `pnpm db:migrate` against the explicitly selected deployment database. It changes Developer rows and the account default to Member, preserves Admin/Viewer, and rejects subsequent legacy role writes. It also creates the configuration, credential, operation, probe and health tables and database fences.
4. Deploy matching services and clients before resuming work. Expert is granted explicitly. Role edits protect the last tenant Admin, recheck the acting Admin transactionally and write their audit record with the change.
5. A changed role requires signing in again; current account state is checked on authenticated requests and execution boundaries. Unexpired legacy Developer token claims normalize to Member during the existing token lifetime (24 hours in stock roots). New tokens never contain Developer. Retiring old issuers bounds that transition.

Do not roll back to binaries that only understand Developer after applying this migration. Configuration rollback publishes a new revision; it does not reverse the schema/role migration, restore revoked keys or revive a currently disabled/retired deployment.

## Connecting providers and selecting models

Open Account → Administration → AI configuration (the drawer is titled AI settings).

1. The Connections list shows each saved connection with Edit/Delete actions. Click Add connection to open a separate form and select a provider, for example Kimi Code · China. Enter the API key directly in that connection card. The preset fills the endpoint and a suggested model; custom connections expose endpoint/protocol under Connection details.
2. Click Save connection. Cancel discards the form without creating/updating a connection. This single save request transactionally saves connection metadata, inline encrypted credentials, settings revision and audit. No model/default/fallback is required to save a connection. A blank key on an existing connection preserves it; an entered key changes it. A rejected write preserves the form/key for correction. Retry unchanged input reuses the operation ID. Acknowledged keys are cleared and never returned or placed in browser storage.
3. Add multiple model IDs to a connection if needed. The China Kimi Code preset suggests `k3-256k`; verify entitlement in your console. Other upstream IDs can be entered directly. Capabilities/context/output limits are under Model details. Protocol compatibility alone does not establish support. New models without a fixed-catalog price mapping remain unpriced; cost ceilings requiring a known rate block their use. Existing price mappings and historical rates are retained.
4. Choose a Default model in the separate Model settings section when ready and click Save model settings. This activates managed routing for this tenant; connecting alone leaves environment routing active until a default is explicitly selected. After activation, clearing the default blocks default-following requests and never restores environment routing.
5. Optionally select ordered Fallback models and explicitly enable automatic fallback. This approves sending eligible requests to those providers. No named profiles are created.
6. Test saved model is under Model details and runs only after explicit confirmation. It sends a short synthetic prompt and may incur charges/use subscription quota. Saving itself does not test inference. Configuration history and role controls are expandable sections.

For an existing profile-based tenant, the drawer warns before conversion and requires confirmation on Save. Review approved destinations and parameters before choosing direct default/fallback settings. The operation retires old profile routing without rewriting historical snapshots. Profile-bound conversations then require an explicit model/default selection. This deliberate migration avoids guessing which old bounds, pins or fallback approvals to keep. New writes cannot restore legacy routing over an activated direct configuration. Keep a database backup and use compatible binaries for rollback.

The operator-only environment import CLI remains a legacy migration aid for an untouched tenant; it does not activate configuration. Its result must be reviewed and converted through the direct provider form before new use. Tenant APIs cannot import deployment-wide secrets.

## Existing conversations and session controls

Use the model/reasoning button at the bottom right of the composer in Main, new Chat/Work and existing conversations. Click to open the picker, then Apply to confirm; closing it discards unapplied edits. New-conversation choices stay local until sending the first request, when they are saved before prompt dispatch. Default follows the tenant's current default at each eligible model-request boundary. An explicit provider/model stays selected when the default changes. Members can select enabled models. Experts/Admins see reasoning effort for OpenAI-compatible reasoning models or a token budget for Anthropic reasoning models, with pin/output controls under Advanced settings. Reset advanced settings removes stale privileged overrides. Removed/disabled selections remain unavailable. Session settings contains permissions and workspace details; model controls live in the composer.

Legacy profile-bound sessions and used conversations without a managed selection require explicit reselection after conversion. Their messages, usage and route receipts remain unchanged. Existing in-flight streams/tools continue; configuration changes are checked before subsequent dispatch. Old readers must be replaced before new writers store direct selections/snapshots.

Child loops inherit the originating authenticated account and model selection. Their receipts/results are journaled to the durable parent log before dispatch. Derived Work inherits its authorized origin where available. Planning reads current model/output/context/pricing metadata without contacting providers. Compaction revalidates the actual purpose-specific request and uses per-request limits. No path regains environment access after activation.

## Outage recovery

Change Default model and Save for sessions following the default. Explicit/pinned selections stay explicit; select a replacement in those conversations if necessary. Restore the preferred default explicitly after recovery. There is no separate publication workflow.

With automatic fallback enabled, a no-output transient, rate-limit or recognized permanent credential/quota failure may use the next approved compatible model. An independent eligible connection need not inherit the failed provider's Retry-After. Existing durable retry/task budgets, deadlines, cancellation, usage reservations and shared cooldowns still apply. Fallback never resets budgets.

Any text, reasoning/signature or tool-call output prevents cross-model continuation. Partial text uses bounded same-model recovery. Incomplete calls never execute. Cancellation, refusal, policy/configuration failures and uncertain tool effects do not authorize failover. Signed history remains bound to the recorded model; the app rejects incompatible destinations instead of dropping history.

Every attempt records a secret-free route receipt before dispatch. Uncertain crash receipts prevent blind resends. Request details show the actual provider/model, default/explicit selection and fallback/pin reason alongside saved prices. Missing usage stays unavailable since failed attempts may still incur charges.

## Shared health, probes and accounting

PostgreSQL circuit observations are shared and request-idempotent. The initial deterministic policy opens a deployment circuit after three transient failures within 60 seconds, and opens a credential scope immediately for recognized permanent failures. Missing observations display Unknown. Automatic routing consults current shared health; manual/pinned choices remain deliberate choices. These initial constants are not a measured production availability guarantee.

Provider retry deadlines are also stored in PostgreSQL and rechecked immediately before dispatch. Rate-limit waits apply to the connection across models and credential rotations; other transient waits apply to the deployment. Overlapping deadlines remain independent, and successful traffic or a circuit restore cannot shorten them. Independently eligible connections can still serve requests.

A circuit stays open until an explicitly requested synthetic probe succeeds against unchanged published settings and the current credential. The shared probe lease bounds half-open work. An old draft's successful test cannot reopen a different publication. Normal traffic does not automatically fail back to a failed primary. Timed background probes, automatic failback and calibrated thresholds remain separate operational acceptance work.

Configuration history shows audited changes; explicit tests report their recorded outcome. The shared probe/health APIs retain versioned observations. Configuration and role changes insert `audit_log` in the same transaction as their write. General application audit delivery retains its existing pipeline. No Redis invalidation message is required for configuration freshness: every dispatch consults authoritative PostgreSQL state.

Synthetic results retain available token buckets and fixed-catalog price/cost snapshots in `llm_probes`. Their token-quota projection uses a synthetic request ID, outside conversation totals, and settles only once. Unknown or incomplete usage retains a conservative 256-token test reservation for the applicable quota window. Interrupted probes are not automatically retried. Provider usage is authoritative when available; these accounting rules do not establish exactly-once provider billing.

Retain referenced configuration/credential metadata and protect database backups and key material. No automatic credential/history garbage collection is implemented. Production retention and key destruction require an operator-reviewed policy.

## Acceptance before production

Run `pnpm test`, `pnpm lint`, `pnpm typecheck` and changed-file formatting. The additional database cases require `TRINITY_TEST_LLM_DATABASE_URL` pointing to a migrated disposable database. Keep regular `DATABASE_URL` and `REDIS_URL` pointed at isolated test services too.

Local deterministic tests, PostgreSQL upgrade/fresh-install checks and browser fixtures do not certify real-provider compatibility, multi-process outage timing, internal-gateway networking or production isolation. Complete the remaining [release gates](production-checklist.md#account-roles-and-llm-configuration-planned) before activating production automatic fallback.
