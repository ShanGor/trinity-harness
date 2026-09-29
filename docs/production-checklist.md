# Production Release Checklist — Trinity Harness (M5)

> M5 acceptance gate (docs/design.md §18 "生产发布 checklist 通过").
> Walk top to bottom before declaring a release ready; record evidence
> (command output / screenshot) next to each item.

## 1. Data & migrations

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
