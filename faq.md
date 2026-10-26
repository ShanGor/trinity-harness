# Frequently asked questions

## Do all agents share Redis? Is that a security issue?

Server and agent-worker processes configured with the same `REDIS_URL` share a Redis deployment for task queues, session event streams, live updates, approvals and coordination. This does not necessarily mean Redis Cluster mode: the current client uses a configured Redis endpoint. PostgreSQL is the authoritative event log; Redis distributes events and work.

| Component                    | Access                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| API server and agent workers | Trusted backend access to shared Redis                         |
| User browser                 | Authenticated backend APIs; no direct Redis credentials        |
| Personal Firecracker guest   | No Redis/PostgreSQL credentials or direct control-plane client |

The agent loop and model calls run in the shared control plane. A personal microVM executes authorized tools through the Node Agent and private guest RPC channel. Sharing Redis does not give a guest access to other users' queues or events.

The main risk is compromise of a trusted backend service or its Redis credentials. A broadly privileged credential can expose other users' events, queue payloads or coordination state. Session key prefixes avoid collisions; they do not enforce tenant isolation. PostgreSQL authorization protects application operations but does not prevent data disclosure by a service that can read Redis directly. Redis logical database numbers are not a substitute for access controls either.

Production hardening should include private network access, TLS, separate Redis ACL credentials by service role, restricted key/channel patterns and commands compatible with each service's actual operations, and authenticated session ownership checks before delivering events or accepting approval responses. Validate queue, stream, Pub/Sub and script requirements before restricting ACLs. These are deployment requirements, not a claim that this development installation has been audited or configured with all of them.

Keep credentials out of guest images, tool environments, browser payloads and logs. Dedicated Redis deployments can provide a stronger infrastructure boundary for customers or tenant groups that require one; a separate deployment per user is generally unnecessary. The current shared deployment alone is not an enforced tenant isolation guarantee.

See [architecture](docs/design.md), [production checklist](docs/production-checklist.md) and [latency diagnostics](docs/deployment-guide.md#runtime-latency-diagnostics).

## Does Chat have fewer tool permissions than Work?

Chat and Work use the same configured tools under their effective session policy. Chat gets an automatic workspace; Work selects one. New Main and side Chat use `workspace-write` with normal approvals, matching the default Work policy. Account admin status does not override a session policy or grant access to the physical VM host.

An earlier stock-client bug explicitly created Chat with `read-only`, which denies Bash and asks before file writes. The correction applies to new creation operations. Existing sessions and pending retries retain their stored policy; change an affected session through authenticated `POST /api/sessions/:sessionId/policy` with `{"policy":"workspace-write"}` before the next prompt. Explicit restrictions are never automatically upgraded. See [deployment guidance](docs/deployment-guide.md#chat-session-storage).

## How does Trinity avoid unnecessary tool activity?

The general Loop instructions require actions to advance the current user objective, reuse evidence and inspect prerequisites before dependent work. Current policy snapshots supersede older assistant statements. Replayable guidance flags repeated tool failures and unchanged reads; it does not decide semantic success or automatically stop legitimate work. Stock v2 verification requires a minimal committed plan before mutations or unknown-effect calls, including small edits; ordinary reads and direct answers need none. This makes the existing final-verification prerequisite explicit before actions run. Plans do not grant execution authority. Personal execution stays inside the assigned guest VM.

Operators can optionally configure `TASK_MAX_TOOL_CALLS` on both server and worker (Helm: `config.taskMaxToolCalls`). It is shared across parent/children and persists across recovery. A tool wave that cannot fit is rejected before execution; the model then concludes with supported findings and gaps when other budgets permit. Omitted ceilings remain unlimited. Limits bound activity; representative model evaluations and human review are still needed to judge whether actions were useful. See [execution controls](docs/deployment-guide.md#general-action-controls) and [evaluation](docs/intent-evaluation.md).
