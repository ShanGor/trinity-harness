# Latest personal conversation performance review — 2026-10-24

## Scope and evidence

Read-only review of the configured browser owner's latest completed personal turn at inspection time. Request: report the assistant's running environment. Session `01a16e0e-2492-7000-bc27-4e8931000b91`, prompt `01a16e20-a021-7001-9465-201bcdc9dc81`, PostgreSQL event sequences 15–43. It ran from **21:36:34.337 to 21:36:45.369 HKT** (13:36 UTC). The prior completed turn in the same session took 13.254 seconds for a different request; that is not a controlled before/after comparison.

The current turn completed in **11.032 seconds**, with three model requests using `anthropic/MiniMax-M3`, four tool calls, three tool errors and no recorded compaction, model recovery or approval wait. A `completed` terminal event does not establish that the environment-information request was fully satisfied.

## Timing reconstruction

These are intervals between persisted application/event timestamps, not captured provider traces. Model windows start at the committed context receipt and end at usage persistence, so they include adjacent dispatch/accounting overhead and cannot isolate provider compute, network latency or time to first token.

| Interval                                  |        Duration | Evidence                                       |
| ----------------------------------------- | --------------: | ---------------------------------------------- |
| Accepted user event → turn start          |         0.051 s | seq 15 → 16                                    |
| Accepted user event → first model context |         0.159 s | seq 15 → 21; includes the preceding 0.051 s    |
| First model window                        |         2.954 s | seq 21 → 22                                    |
| Two denied Bash calls                     | 0.002 s elapsed | seq 24/25 → 26/27; never executed in the guest |
| Second model window                       |         0.760 s | seq 30 → 31                                    |
| Glob and file-read calls                  | 0.024 s elapsed | seq 32/33 → 34/35; one success, one error      |
| Third model window                        |         6.992 s | seq 38 → 39                                    |
| Final answer persisted → terminal event   |         0.005 s | seq 40 → 43                                    |

The three model windows total **10.706 seconds**, approximately **97%** of turn time. All remaining intervals together total 0.326 seconds. Tool timings above overlap within their respective batches and must not be added as independent serial costs.

Usage events record 24,989 input tokens across the three requests (including repeated context), 829 output tokens and 16,716 cache-read tokens. Individual context snapshots grew from 30,730 to 32,222 serialized bytes. These data do not establish context bloat as the bottleneck. The final model window accounts for most elapsed time, but its first-token latency and steady generation rate were not retained.

## Reliability and delivery findings

- Both Bash calls were rejected by the session permission policy in about 2 ms. This was authorization enforcement, not slow shell execution. Advertising or requesting unusable tools added an unsuccessful model/tool round trip; the model then tried file tools.
- `glob("**/*")` succeeded. `read_file("README.md")` returned the generic personal-VM-unavailable error. The environment was still `running` at inspection. This does not prove a VM outage: code inspection shows that guest execution exceptions, including a missing-file exception, become HTTP 503 and then the generic transport error. The original guest exception is absent from the reviewed control-plane events, so missing-file error translation is a plausible explanation, not a proven diagnosis of this call.
- The final answer both declared the workspace empty and later called its contents unverified. It also described file tools as responding normally despite the read failure. This turn therefore has a clarity/reliability problem beyond its elapsed time.
- Redis retained all 29 events in the reviewed range, and its tail `43-0` matched PostgreSQL seq 43 at inspection. There was no retained-stream gap. This does not measure publication latency, Pub/Sub text delivery, browser receipt or rendering time.
- No process was listening on the documented Prometheus ports 9464–9466 at inspection. No per-request trace or first-token sample was available to this review. The new instrumentation cannot reconstruct historical measurements that were not exported.

## Improvement priorities

1. Preserve typed, bounded operation errors across guest RPC so an expected file-read failure can be distinguished from unavailable transport or an unknown effect. Continue enforcing generation/ownership checks and do not retry uncertain effects. This requires contracts and adapter coverage; it is not implemented by this documentation review.
2. Avoid presenting explicitly denied tools as usable capabilities, or make their denial explicit in model context. Keep authorization enforcement at execution time. Environment questions should not automatically trigger repository inspection. Model guidance and capability filtering should be evaluated for fewer failed calls rather than assumed to improve task success.
3. Enable distinct telemetry ports on the existing server, worker and Browser Runtime, then collect a representative next turn. Separate dispatch preparation, model first output/text and duration, and guest metadata/environment/transport. Add browser receipt/render measurements before attributing a UI delay to Redis. See [deployment diagnostics](deployment-guide.md#runtime-latency-diagnostics).
4. If actual model timings remain dominant, compare a shorter answer and alternative configured models on equivalent requests, recording correctness and cost as well as latency. Do not remove security checks or weaken evidence requirements for speed.

For this turn, the evidence points primarily to time around model requests and avoidable failed tool attempts. It does not support blaming microVM routing for a multi-second delay. Eleven seconds is usable for an inspected environment report but has room to improve; missing environment evidence prevents calling the result fully healthy. No runtime settings or session permissions were changed by this review.

## Implementation follow-up

The follow-up implementation filters explicitly denied tools from model schemas and adds bounded, operation-bound guest text/binary read errors. Approval-gated tools and execution-time enforcement remain in place. Missing-file acceptance now verifies that the guest subsequently serves a healthy read. Control-plane and guest-boundary tests cover malformed, stale and revoked responses. Guest deployment requires rebuilding its source snapshot/rootfs and waking a fresh generation; repository edits alone do not upgrade the existing VM. These mechanism changes have not yet been measured on a comparable real-model turn, so they do not establish an end-to-end latency or semantic-quality gain.
