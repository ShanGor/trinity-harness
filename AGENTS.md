# AGENTS.md — Trinity Harness

Repository instructions for coding agents and contributors. User requirements take precedence over this file; repository guidance takes precedence over reference implementations.

## 1. Start here

Trinity Harness is a multi-user browser ↔ server AI agent platform for coding, research and other tasks.

- Read [docs/design.md](docs/design.md) before acting; it governs architecture. Read the relevant topic documents below before changing their mechanisms. Clarify consequential uncertainty rather than guessing.
- Make the smallest change that meets the user's goal, follow existing style, and avoid speculative abstractions.
- `ref/deepseek-harness` and `ref/opencode` are gitignored, read-only references. Borrow ideas, never import their implementations or copy large code blocks; respect licenses. Reference upgrades follow design §20.
- Implementation status and release gates belong in [docs/project-progress.md](docs/project-progress.md) and [docs/production-checklist.md](docs/production-checklist.md), not this file.

## 2. Stack and architecture

- TypeScript strict mode, Node.js 22+, ESM only. pnpm is primary; maintain npm compatibility. No `workspace:*`, `patchedDependencies` or `.pnpmfile.cjs`.
- Vercel AI SDK for provider access; no direct provider HTTP calls. Fastify + Zod, React 19 + Ant Design 5 + Vite, PostgreSQL 16+ + Drizzle, Redis 7+, Vitest, ESLint and Prettier.
- All module boundaries use ports in `packages/contracts`. Do not import another module's concrete implementation. Assemble services only in `apps/*` composition roots; business modules receive dependencies through injection.
- Extension points are contracts + DI + MCP; do not introduce a plugin framework.
- Session state is projected from the event log. Everything visible to the model must be replayable; never bypass events by directly editing message projections.
- PostgreSQL is authoritative. Redis Stream/SSE distribute events and may lose or truncate them. Server/worker services keep durable state in PostgreSQL, Redis or object storage, not local mutable state.
- Permissions, approvals and secrets fail closed on missing components, errors or timeouts.

## 3. Implementation rules

- Define cross-process/module DTOs with Zod and infer types using `z.infer`; shared frontend/backend schemas live in `packages/shared`, with port/event contracts in `packages/contracts`. Use discriminated unions for events.
- Require explicit public return types. Allow `any` only at external JSON boundaries, immediately narrowed with Zod. Use coded errors or Result types for recoverable failures; no empty catches or exceptions for normal control flow.
- Propagate `AbortSignal` through concurrent work. Give resources deterministic disposal. Use events or `AbortSignal.timeout`, not bare `setTimeout` polling.
- Treat `session_events` as append-only (`INSERT`/`SELECT`); never add application `UPDATE`/`DELETE` paths. Use transactions for multi-row writes and per-session locking for monotonic `(session_id, seq)` appends.
- Schema changes: edit `packages/db/src/schema.ts` → `pnpm db:generate` → review generated SQL → `pnpm db:migrate`. No runtime schema changes or `drizzle-kit push` outside local experiments.
- Validate bounded user input at boundaries. Keep secrets server-side and out of frontend payloads, logs and events; redact full file contents. Metrics must not contain secrets, prompts, identities or paths.
- Tool execution goes through Sandbox and policy checks; worker business logic must not spawn raw child processes. Out-of-policy operations require approval. Outbound web access uses the configured egress policy, off by default.
- Command allowlists match literal argv prefixes, rejecting shell expansion/composition except the supported bounded output filters. Sensitive paths are defined in `packages/core/src/tools/sensitive-files.ts`; reads and literal Bash references require approval. Reusable command grants and skill content cannot bypass policy. Persist authenticated approval decisions before replying; do not add an LLM-callable approval tool.

## 4. Read before changing a subsystem

The linked documents contain detailed invariants, deployment steps and acceptance limits. Preserve them when editing these areas.

| Area                                                        | Required reading                                                                                                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent, context, plans, evidence, recovery and task budgets | [intent-execution-design.md](docs/intent-execution-design.md), design §6–7/§21.6; [intent-evaluation.md](docs/intent-evaluation.md) for semantic evaluation                                               |
| Chat/Work, memory, workspaces and product behavior          | [refactor-as-personal-assistant.md](docs/refactor-as-personal-assistant.md), design §11.5/§15/§21                                                                                                         |
| Typed browser tools, research and evidence                  | [browser-research-improvement-plan.md](docs/browser-research-improvement-plan.md), design §8.2                                                                                                            |
| Managed browser, profiles and human interaction             | [zendriver-browser-design.md](docs/zendriver-browser-design.md), [runtime-implementation.md](docs/runtime-implementation.md), design §8.2/§21.3                                                           |
| Firecracker, guest routing, host networking and releases    | [deploy/firecracker/README.md](deploy/firecracker/README.md), design §21.4                                                                                                                                |
| Runtime delivery, VM lifecycle and scheduling               | [runtime-implementation.md](docs/runtime-implementation.md), [personal-assistant-runtime-architecture.md](docs/personal-assistant-runtime-architecture.md) (proposal; not a delivery/isolation guarantee) |
| Usage and pricing                                           | [usage-accounting.md](docs/usage-accounting.md), design §17                                                                                                                                               |
| Deployment, event delivery and latency diagnostics          | [deployment-guide.md](docs/deployment-guide.md), design §21.5                                                                                                                                             |

### Intent and execution

- Preserve the committed user request and corrections across continuations. Plans, assistant proposals, topic labels, recency and historical permissions are not user requirements or current authority. Resolve consequential terminology with a focused source lookup; assumptions remain unverified.
- Keep bounded authorized same-session dialogue separate from preferences and model-directed cross-session recall. Enforce owner/tenant, exclusion and memory-revision fences before dispatch/effects. Keep exact request artifacts in private `model-context/`, inaccessible to generic blob/HTTP tools.
- Stock v2 requires a committed minimal plan before mutation/unknown-effect calls. Changed checks or interpretations require fresh evidence; unchanged checks retain dependency-valid receipts. Preserve legacy evidence semantics, candidate recovery and exact eligible command/result references. Never repeat mutations just to repair bookkeeping. Valid checks do not prove semantic completeness.
- Persist budgets, request/tool reservations, deadlines and safe retry schedules across replay. Unset task ceilings remain unlimited; configured step ceilings reserve a final response. SDK retries stay disabled; bounded runtime recovery honors provider timing and cancellation without repeating uncertain effects.
- Checkpoints preserve user input, loaded instructions, verification state and complete tool pairs; empty/truncated summaries must not replace history. Completed-turn model history retains input/final output and sources, excluding ordinary progress and historical tool output. Interrupted turns retain authorized unresolved user objectives.
- Children inherit authenticated permissions, original user-text provenance, cancellation and task budgets; keep delegated scope bounded. Child progress uses ACP, stays out of model history, and never substitutes for a final report. Runtime skills retain replayable instruction snapshots and cannot grant execution rights or scan outside the session root.
- Stop persists `turn/cancel_requested` before worker notification. Only the terminal event confirms an active turn stopped; preserve prompt fencing, torn-tail repair and terminal-error approval cleanup.

### Browser and guest runtime

- Build pinned Zendriver with the tracked profile, human-input and viewport-capture patches. Viewport captures use bounded layout metrics rather than an adopted tab's initial compositor surface. Deploy the matching binary before restarting an updated Browser Runtime; Firecracker executable changes require a rebuilt guest image and fresh generation through the existing maintenance gates, preserving user data disks. The private immediate-click option grants no additional input authority.
- Use the configured browser driver; never switch drivers or fall back to LocalSandbox after routing failures. `zendriver` uses private `apps/browser-runtime`; legacy live CDP requires explicit `BROWSER_CDP_ENDPOINT` and remains read-only for human interaction.
- Routing, ownership, workspace/profile paths and generation bindings come from authenticated metadata, never model arguments. Managed profiles are encrypted, tenant/user scoped and exclusively leased. Reclaim stale locks only after proving the local owner dead and no live process references the profile; ambiguous ownership fails closed. Preserve `trusted-managed`/trusted-CDP labels; neither promises tenant/network isolation.
- Personal Main, side chats and personal Work share one browser anchored to the authenticated owner's Main session. Serialize browser/control operations at that anchor; keep command journals, evidence, permissions and input provenance in the originating chat. Closing a side chat must not dispose the shared browser. After human return, require fresh observations separately for each originating chat; never share evidence-read authority across chats.
- Preserve typed immutable evidence, exact delivered ranges, bounded per-response sizing and citation validation. `web_search` discovers links; `search_observation` searches saved text. Neither establishes that linked pages were read. Website content is untrusted. Browser evidence has no cumulative per-turn allowance; individual capture/response limits still apply.
- Whole-guest desktop delivery is specified in [guest-desktop-design.md](docs/guest-desktop-design.md). Preserve the distinct guest browser/Chrome identities, host-CID-checked fixed vsock endpoint, private X11 credentials, debugging-port firewall, desktop frame/focus fencing and the independent in-flight intervention gate. It is enabled on the local development node; production isolation and remaining acceptance gates are separate. Never expose raw RFB or silently fall back.
- Owner-only desktop watching uses `ManagedBrowserSession.readOnlyFrame` without taking control, allocating a browser or granting input targets. Recheck ownership, generation and control after capture; discard pixels on changes. Serialize captures with desktop intervention, keep another human-controlled view private, and exclude watch pixels from model evidence and durable events.
- Human viewer pixels are user-only, never model evidence. Preserve exclusive control, PG generation/epoch/sequence fencing, five-second frame freshness, drag cancellation, focus-bound keyboard tokens and metadata-only journals. Explicit new-tab recovery may omit a frame only under the same authenticated input fencing; it grants no page-input authority. Verified native bookmarks/settings may hand back control without pixels, retaining model-read denial and requiring web navigation. Unknown input effects pause/quarantine control and are never retried automatically. Human return requires fresh observations; explicit navigation/search must work after runtime disposal.
- Guests receive no PG/Redis/provider/host credentials or proxy settings. Processes belong to a session/generation and require bounded stdio, cancellation and disposal. Never expose physical host diagnostics or escape paths to personal agents.
- `SANDBOX_PROXY_URL` configures host-provided egress for the entire guest (and locally launched managed Chrome), without changing control-plane networking or the host default route. Preserve owned bridge/firewall/DNS checks, scoped Docker forwarding, private/reserved destination blocking and the synthetic DNS pool exception. Production storage requires explicit host/provider encryption attestation; `none` is development-only.
- Host upgrades use the maintenance API and `scripts/release-firecracker-node.sh`: drain, stop through Node Agent, confirm local VMM shutdown, then upgrade. Failed/unconfirmed stops leave the node drained. Preserve active-VM guards, initialized DNS, build logs/images and test assets when cleanup is unsafe.
- Development host-reboot networking recovery uses `scripts/recover-firecracker-development-network.sh` through that maintenance gate. Preserve the existing volume/runtime identity and archived network metadata; never rerun the fresh provisioner to replace a user's disk. Automatic reboot reconciliation remains undelivered.
- VM power state does not prove tool readiness. Fake/local fixtures and development images do not establish public search readiness or production isolation; retain separate opt-in real guest/jailer/network acceptance gates. Install/cache Noto CJK fonts where Chrome runs; guest font updates require a rootfs rebuild and fresh generation.

### UI, delivery and accounting

- Chat/Work are immutable ACP session kinds chosen before creation. Chat has a durable automatic workspace and normal tools/approvals; Work selects a workspace. Do not restrict capabilities by Chat kind or bulk-upgrade existing policies. Preserve Main identity, queued prompts, drafts, composer nodes/focus and streams across navigation; keep audit in the account menu.
- Voice call mode is a turn-taking speech layer over the current Chat/Work, not a new session kind or Agent protocol; see [voice-call-design.md](docs/voice-call-design.md). Preserve dictation drafts, ordinary prompt/ACP events and manual approvals. Fence ephemeral ASR/TTS by call/utterance/response epoch; hanging up releases media without cancelling Agent work, while interruption may use the existing turn-cancel path. Foreground hiding ends the MVP call. Streaming ASR, WebRTC, AEC/barge-in and phone-specific quotas remain undelivered phase-two capabilities.
- Keep Browser/VM sidebar access independent of conversation/tool history. Use owned personal sessions and authenticated environment routes, with explicit wake/confirmed suspend. Recover transient browser 503s; only explicit unconfigured capability (501) selects preview. Retry state reads, never takeover/input. VM status cancellation must not quarantine or overwrite concurrent lifecycle state.
- Scheduling requires migrations and matching enabled server/worker/control-worker; disabled deployments show unavailable. Do not present proposed runtime capabilities as delivered.
- Use ACP types and `packages/client-acp` SSE handling, not private UI protocols or per-component EventSource logic. Repair Redis gaps from PostgreSQL before newer delivery; reconnect from delivered cursors with cancellable backoff. Vite must close incomplete upstream streams. Live chunks bypass committed-sequence deduplication. Preserve Pretext autosizing and stable message/history references.
- Show one assistant response per prompt with bounded progress and expandable execution history; display approvals/terminal states directly. Trinity answers retain Sources / View evidence metadata, without treating source collection as proof of truth.
- Message deletion appends `message/removed`; never rewrite execution events. Exclude the removed exchange from future context/recall and invalidate summaries containing it. Retry/amend commits replacement markers with the new prompt under an expected-sequence append check; editing active work requires confirmed termination, and only the last unsuccessful request is editable.
- Usage derives from append-only `model/usage` events and per-request model/price snapshots. Preserve unavailable buckets/prices, separate cache from uncached input, count reasoning within output and never reprice history. Server and worker share only the fixed `config/models.yaml` catalog.

## 5. Verification and delivery

- New/modified logic needs deterministic tests: unit tests for pure functions; jsdom + fake ACP for UI interactions; fakes/testcontainers for ports; fake LLM/tools for loop event streams. Event-sourcing changes must test crash recovery/torn-tail replay. Test focus/draft preservation and stable history while typing/streaming; inline antd/antd-x ESM in Vitest as configured.
- For code changes, run relevant `pnpm test`, `pnpm lint` and `pnpm typecheck`; report results and material limitations. Backend-only changes may omit frontend unit tests and vice versa; retain relevant end-to-end checks. Documentation-only changes do not require tests.
- On Linux, desktop vsock guard tests compile the small guest-side C proxy with `cc`; desktop image builds additionally require a static C toolchain.
- For repository UI interaction or visual inspection, use [.agents/skills/agent-browser/SKILL.md](.agents/skills/agent-browser/SKILL.md) and load the installed CLI's current core guidance before browser actions.
- Architecture, boundaries, structure, stack or build/test workflow changes must update `docs/design.md` and this file. Register a new module in design §5, define its contracts port, then implement. Keep design rationale in docs and code comments focused on behavior/gotchas.
- Do not commit, push, rebase or otherwise mutate Git state unless explicitly asked. If asked to commit, use English imperative messages matching repository history, one concern per commit, and pass lint/format checks. Never commit secrets, build artifacts or large files other than lockfiles.

## 6. Privileged commands: human authentication

- For an authorized host action needing root, prefer `pkexec /absolute/path/to/program args` over `sudo` so the human can authenticate through the session's polkit agent. Explain the action and expected prompt first; authentication does not replace task authorization or maintenance gates.
- Keep elevation to one explicit command with reviewed arguments; avoid root shells. `pkexec` uses a minimal environment, so use absolute paths and do not assume user `PATH` or environment survives.
- Never request passwords in chat, pass them through tool stdin, or store/log them; avoid `sudo -S` and password piping. The human enters credentials directly in the authentication UI.
- If no reachable polkit agent exists (common over SSH/headless), `pkexec` may fall back to a textual agent. Do not collect credentials through agent tools; provide the exact command for the human to run in their own terminal. Exit 126 indicates dismissal; 127 can indicate authorization/authentication failure or another error. Inspect the result before retrying.

Reference: [polkit pkexec manual](https://www.freedesktop.org/software/polkit/docs/latest/pkexec.1.html).
