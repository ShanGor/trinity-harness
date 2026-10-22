# Token usage and estimated cost

Every model request records a `model/usage` event in the session log. The turn footer and session header open the same accounting panel: uncached input, cache reads, cache writes, output, reasoning within output, input cache-hit percentage, estimated money spent, and a breakdown by model. Session export includes these records.

Session totals sum request consumption across turns, including reported compaction and subagent calls. They measure cumulative consumption, not the size of the current context. A model change keeps previous requests attributed to their original model. Rate changes never reprice previous requests. Request IDs prevent duplicate counts during replay/reconnection, while prompt IDs attach usage to the originating turn.

## Configure prices

Configure all prices in the single `config/models.yaml` file. It is loaded from that fixed path by both the server and agent worker and included in their Docker images. The `models` map is keyed by the exact routed `provider/model-id`; each value is an array of price tiers. All rates are **quoted decimal strings in currency units per million tokens**. For example:

```yaml
models:
  provider/model-id:
    - currency: USD
      version: operator-rate-v1
      input: '2'
      output: '10'
      cacheRead: '0.2'
      cacheWrite: '2.5'
      minInputTokens: 0
```

The checked-in catalog contains direct-provider reference rates for Kimi K3, MiniMax M3, MiniMax M3.1 Flash (China), and DeepSeek V4.1 Flash. Rates are snapshots dated in the YAML; update them when provider prices change, and replace them when a proxy, discount, priority tier, or account-specific contract changes the actual rate. A model without an entry has unavailable cost. Update the file and redeploy the server and worker images when rates change. New requests save the selected rate snapshot alongside their cost, so existing sessions are never repriced.

The catalog keeps prices in each provider's published currency; totals in different currencies remain separate. DeepSeek's configured rates use its peak schedule because the catalog cannot represent time-based rates. Kimi K2.8 Preview is available through the Kimi Code subscription/quota product as `kimi-for-coding`, not with a published per-token API rate, so it is intentionally not assigned a money rate. The public pricing tables for MiniMax M3 and M3.1 Flash do not list a cache-write price; requests reporting cache writes therefore have unavailable cost rather than an assumed rate.

Each tier supports:

| Field              | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `currency`         | Three-letter uppercase currency code                                         |
| `version`          | Operator-assigned rate version                                               |
| `input` / `output` | Uncached input / total output rate                                           |
| `cacheRead`        | Cached input read rate; optional when no reads occur                         |
| `cacheWrite`       | Cache write rate, or short-duration rate when a duration split is configured |
| `cacheWrite1h`     | Optional one-hour cache write rate                                           |
| `minInputTokens`   | Minimum **total** input for this tier; defaults to zero                      |

The tier with the greatest eligible `minInputTokens` is selected. A threshold uses the entire input, including cache reads/writes. Rates accept up to eight fractional digits. Money is calculated server-side with integer arithmetic at fourteen decimal places, then rounded for display. Different currencies remain separate totals.

Input total includes uncached input, cache reads and cache writes. Output includes reasoning. For known disjoint buckets:

```text
cost = (uncached input × input rate
      + cache reads × read rate
      + short cache writes × write rate
      + one-hour cache writes × one-hour rate
      + output × output rate) / 1,000,000
```

### MiniMax M3.1 Flash (China)

Use the existing Anthropic-compatible gateway with these settings on both server and worker:

```dotenv
MODEL=anthropic/MiniMax-M3.1-Flash
ANTHROPIC_BASE_URL=https://api.minimax.cn/anthropic/v1
ANTHROPIC_API_KEY=<your-minimax-api-key>
MODEL_CONTEXT_TOKENS=1000000
```

The AI SDK Anthropic provider requires `/anthropic/v1` as its base URL. Keep the key server-side. Thinking is mandatory and enabled by default; leave `REASONING_BUDGET_TOKENS` unset to avoid Claude-style budgeted thinking. The provider defaults to maximum thinking effort. The existing output and compaction budgets remain independently configurable.

The [China pricing table](https://platform.minimax.cn/docs/pricing/overview#models/text), checked on 2026-10-20, lists flat rates per million tokens: CNY 1 input, CNY 4 output (including reasoning), and CNY 0.1 cache reads. No cache-write rate is published. This catalog entry describes China pay-as-you-go billing; change the rates if using a different region or billing arrangement. Restart server and worker after changing the environment or catalog; deployed images need rebuilding for catalog updates. Existing sessions may retain their selected model, so select the new model in Session settings or start a new session.

## Missing data and scope

An absent cache count is unknown, not automatically zero. A missing bucket can only be derived when the provider's exact total and other buckets force its value. Missing rates or required counts produce unavailable cost. Mixed priced/unpriced requests show the known money subtotal with a partial label. Old sessions retain unavailable usage; discarded historical cache details cannot be reconstructed.

When `cacheWrite1h` is configured, a request with cache writes needs a reported duration split. The gateway reads Anthropic's one-hour count from raw SDK usage when available; compatible endpoints may omit it. Without the split the request's cost is unavailable. Omit `cacheWrite1h` only when a single configured write rate applies to all writes for that route.

Failed/cancelled streams retain usage received before termination; requests that report no usage remain unavailable. Provider-internal attempts that expose no usage cannot be accounted for exactly. These are estimates of configured token charges, not provider invoices: taxes, credits, external tool charges and unsupported billing adjustments are excluded. Configure a separate model route for distinct billing arrangements that cannot be represented by input thresholds.

The existing `model_usage` table remains the tenant token-quota projection. Session accounting is durable in `session_events`, requires no database migration, and survives compaction because the accounting projection reads the complete event log. Auxiliary model calls are included in tenant token quotas; subagent records are forwarded to the parent log without recording the same tokens twice in the quota table.
