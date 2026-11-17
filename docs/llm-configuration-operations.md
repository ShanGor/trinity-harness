# Operating tenant LLM configuration

The checkout implements Admin / Expert / Member / Viewer and tenant-managed provider routing. Deployment and real-provider outage acceptance remain release gates. This runbook describes the required cutover; the implementation task does not deploy services or activate a live tenant.

## Infrastructure setup

PostgreSQL, authenticated accounts and matching server/worker binaries are required. Local unauthenticated mode retains static environment configuration and exposes no provider management authority.

Configure the following on both server and worker through the deployment's private environment or secret delivery:

```dotenv
LLM_CREDENTIAL_KEY_ID=v1
LLM_CREDENTIAL_KEYS={"v1":"<canonical-base64-encoded-32-byte-key>"}
LLM_PROVIDER_DESTINATIONS=[{"origin":"https://api.openai.com"},{"origin":"https://api.anthropic.com"},{"origin":"https://api.kimi.com"}]
```

Provision a cryptographically random 32-byte wrapping key through the operator's secret-management process. Never put its actual value in a ticket, repository or browser. The JSON key ring supports retaining previous key IDs while new replacements use the current ID. Preserve every wrapping key still required to decrypt retained credential versions. Rotate provider credentials through Replace key; retire old wrapping keys only after reviewing all dependent versions and backups. Encryption uses a random AES-256-GCM data key for each version, wrapped by the infrastructure key; tenant, connection and version are authenticated in both layers.

The default destination policy permits the public HTTPS origins above, including China Kimi Code at `api.kimi.com`. Kimi Code uses the subscription entitlement; Moonshot Open Platform at `api.moonshot.cn` is a separate pay-as-you-go API and is not the endpoint for this subscription. Add other provider origins explicitly, including the exact port. A private gateway requires an explicit operator rule such as `{"origin":"https://gateway.example:8443","allowPrivate":true}`. This authorizes only that origin; TLS verification still applies. Admins cannot modify this infrastructure policy through the UI. Configuration writes validate origin/scheme policy without requiring live DNS, so a provider DNS outage cannot block emergency publication. Tests and inference use fresh bounded DNS checks, a pinned validated connect address, no redirects and no ambient proxy inheritance through the same SDK transport. Guest/browser egress settings are independent.

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

## Preparing the first tenant

Use Account → Administration · AI configuration:

1. Add named connections and model deployments. Choose the protocol, approved HTTPS endpoint, upstream model ID, context/output limits and supported capabilities. Set the deployment's explicit `config/models.yaml` pricing key. Unknown rates remain unavailable and cannot satisfy a configured task cost ceiling.
2. Add a routing profile, approve its possible destinations/deployments, select a primary, and choose the tenant default. Start with manual routing while preparing backups. Save the complete draft before replacing a connection key.
3. Replace each key through its write-only dialog. The browser clears the submitted field. Reads return configured/revoked/version metadata only.
4. Test saved connections if desired. The confirmation explains synthetic input and possible charges. Tests send no conversation content, are limited to one concurrent request and ten starts per hour per tenant, and time out after 20 seconds. A passing test proves only that short text request at that time. Draft changes invalidate test relevance through the recorded configuration version.
5. Save edits and review publication. The version-bound impact preview counts bound conversations, pins and unbound sessions. Review approved destinations before activating database mode. Publishing changes routing for future admitted requests without restarting processes.

An operator may import the existing environment connection into one explicitly identified tenant's untouched draft:

```sh
pnpm --filter @trinity-harness/server exec tsx src/import-llm-configuration.ts \
  --tenant-id <tenant-uuid> --admin-id <admin-user-uuid> \
  --allow-tools --allow-images --allow-reasoning
```

Supply only capability flags supported by the selected model; files have a separate `--allow-files` flag. The command loads the repository/app environment, verifies the named Admin's tenant, validates the operator endpoint policy and encrypts the selected adapter key. It saves a draft and credential without activation. There is no tenant-facing API that imports deployment-wide environment secrets. A partial import leaves environment routing active; repair the draft/key through administration before publication.

## Existing conversations and session controls

New HTTP/ACP conversations capture the default profile in their creation event. A bound profile follows later publications; changing the tenant default does not move it. Historical used conversations without a managed binding must explicitly select an approved AI profile in Session settings before continuing after activation. The implementation does not guess their historical endpoint or invent deployment identities for old usage.

Members can select approved profiles. Experts/Admins can pin an approved deployment, reorder published backups and set output/reasoning controls inside the profile bounds. Pins never traverse backups automatically. Reset advanced settings removes a stale Expert override after a role downgrade or bound change. Removing a bound profile leaves it unavailable until a user explicitly selects another one; the impact preview exposes its bindings before publication.

Child loops inherit the originating authenticated account and routing scope. Their route receipts/results are also journaled to the durable parent log before dispatch. Scheduled/derived Work inherits its authorized origin's routing settings when available. Planning reads the current deployment output/context and pricing values without resolving secrets or contacting a provider. Complete dispatch revalidates the actual request. Compaction keeps its own messages, uses per-request model windows and the originating routing scope, and does not mutate another session's limits. These paths do not regain environment access after activation.

## Outage recovery

Routing → Published profile → Use backup saves and publishes a reviewed emergency switch. Its confirmation explains replacement of the current draft and the next-request boundary. In-flight streams and tool operations continue. Pinned conversations remain pinned. Restore a primary explicitly when ready, or review a prior revision and publish it as a new revision.

Automatic mode may use the next untried compatible approved deployment after a no-output transient failure, rate limit or recognized permanent credential/quota failure. It does not wait out the failed connection's Retry-After before trying an independently eligible connection. If alternatives are exhausted, the existing bounded scheduler may retry an elapsed transient route. Attempts, waits and reservations share the existing persisted task allowance. A backup does not reset it.

Any text, reasoning/signature or tool-call output prevents cross-deployment continuation. Partial text uses the existing bounded same-deployment recovery. Calls from incomplete tool responses never execute. Cancellation, refusal and authorization/configuration failures are not outage fallback authority. Active signed/reasoning history requires the recorded originating deployment; incompatible targets are rejected rather than stripping history.

Every managed attempt persists a secret-free receipt before dispatch. An uncertain receipt left by a crash prevents blind resend; inspect the conversation and submit an explicit retry. Available failed-attempt usage remains counted. Missing usage remains unavailable, since a failed response may still have incurred provider charges. Request details show actual deployment/model, profile and fallback/pin reason alongside saved pricing.

## Shared health, probes and accounting

PostgreSQL circuit observations are shared and request-idempotent. The initial deterministic policy opens a deployment circuit after three transient failures within 60 seconds, and opens a credential scope immediately for recognized permanent failures. Missing observations display Unknown. Automatic routing consults current shared health; manual/pinned choices remain deliberate choices. These initial constants are not a measured production availability guarantee.

Provider retry deadlines are also stored in PostgreSQL and rechecked immediately before dispatch. Rate-limit waits apply to the connection across models and credential rotations; other transient waits apply to the deployment. Overlapping deadlines remain independent, and successful traffic or a circuit restore cannot shorten them. Independently eligible connections can still serve requests.

A circuit stays open until an explicitly requested synthetic probe succeeds against unchanged published settings and the current credential. The shared probe lease bounds half-open work. An old draft's successful test cannot reopen a different publication. Normal traffic does not automatically fail back to a failed primary. Timed background probes, automatic failback and calibrated thresholds remain separate operational acceptance work.

Activity shows configuration changes, probe versions/timestamps/status and recent circuit observations. Configuration and role changes insert `audit_log` in the same transaction as their write. General application audit delivery retains its existing pipeline. No Redis invalidation message is required for configuration freshness: every dispatch consults authoritative PostgreSQL state.

Synthetic results retain available token buckets and fixed-catalog price/cost snapshots in `llm_probes`. Their token-quota projection uses a synthetic request ID, outside conversation totals, and settles only once. Unknown or incomplete usage retains a conservative 256-token test reservation for the applicable quota window. Interrupted probes are not automatically retried. Provider usage is authoritative when available; these accounting rules do not establish exactly-once provider billing.

Retain referenced configuration/credential metadata and protect database backups and key material. No automatic credential/history garbage collection is implemented. Production retention and key destruction require an operator-reviewed policy.

## Acceptance before production

Run `pnpm test`, `pnpm lint`, `pnpm typecheck` and changed-file formatting. The additional database cases require `TRINITY_TEST_LLM_DATABASE_URL` pointing to a migrated disposable database. Keep regular `DATABASE_URL` and `REDIS_URL` pointed at isolated test services too.

Local deterministic tests, PostgreSQL upgrade/fresh-install checks and browser fixtures do not certify real-provider compatibility, multi-process outage timing, internal-gateway networking or production isolation. Complete the remaining [release gates](production-checklist.md#account-roles-and-llm-configuration-planned) before activating production automatic profiles.
