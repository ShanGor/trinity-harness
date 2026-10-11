import { memo, useMemo, type ReactElement } from 'react';
import { Popover } from 'antd';
import {
  summarizeUsage,
  type ModelUsage,
  type TokenUsage,
  type UsageCost,
} from '@trinity-harness/shared';

const countFormat = new Intl.NumberFormat('en-US');
const compactFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
function count(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : countFormat.format(value);
}
function costs(values: UsageCost[]): string {
  if (!values.length) return 'Cost unavailable';
  return values
    .map(({ currency, amount }) => {
      const value = Number(amount);
      return `${currency} ${value > 0 && value < 0.000001 ? '<0.000001' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
    })
    .join(' + ');
}
function TokenDetails({ tokens }: { tokens: TokenUsage }): ReactElement {
  const cacheHit =
    tokens.inputTokens && tokens.cacheReadTokens !== undefined
      ? `${((100 * tokens.cacheReadTokens) / tokens.inputTokens).toFixed(1)}%`
      : undefined;
  return (
    <dl className="usage-token-details">
      <dt>Uncached input</dt>
      <dd>{count(tokens.uncachedInputTokens)}</dd>
      <dt>Cache read</dt>
      <dd>{count(tokens.cacheReadTokens)}</dd>
      <dt>Cache write</dt>
      <dd>{count(tokens.cacheWriteTokens)}</dd>
      <dt>Output</dt>
      <dd>{count(tokens.outputTokens)}</dd>
      {tokens.reasoningTokens !== undefined && (
        <>
          <dt>Of which reasoning</dt>
          <dd>{count(tokens.reasoningTokens)}</dd>
        </>
      )}
      {cacheHit && (
        <>
          <dt>Input cache hit</dt>
          <dd>{cacheHit}</dd>
        </>
      )}
    </dl>
  );
}

/** The same exact accounting view serves one turn and the entire session. */
export const UsagePanel = memo(function UsagePanel({
  records,
  scope,
  active = false,
  unrecordedTurns = 0,
}: {
  records: readonly ModelUsage[];
  scope: 'Turn' | 'Session';
  active?: boolean;
  unrecordedTurns?: number;
}): ReactElement {
  const summary = useMemo(() => summarizeUsage(records), [records]);
  const { inputTokens, outputTokens } = summary.tokens;
  const total =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  const safeTotal = total !== undefined && Number.isSafeInteger(total) ? total : undefined;
  const partial = unrecordedTurns > 0 || summary.unpricedRequests > 0;
  const totalLabel =
    safeTotal === undefined ? 'Usage unavailable' : `${compactFormat.format(safeTotal)} tokens`;
  const content = (
    <div className="usage-details">
      <p>
        {summary.requests} model {summary.requests === 1 ? 'request' : 'requests'}
        {active ? ' · In progress' : ''}
      </p>
      <TokenDetails tokens={summary.tokens} />
      <p>
        <strong>Estimated cost: {costs(summary.costs)}</strong>
      </p>
      {summary.unpricedRequests > 0 && (
        <p className="usage-note">
          Partial cost: {summary.unpricedRequests}{' '}
          {summary.unpricedRequests === 1 ? 'request has' : 'requests have'} unavailable pricing or
          token details.
        </p>
      )}
      {unrecordedTurns > 0 && (
        <p className="usage-note">
          Partial session totals: {unrecordedTurns}{' '}
          {unrecordedTurns === 1 ? 'turn has' : 'turns have'} no recorded usage.
        </p>
      )}
      {records.length === 0 && (
        <p className="usage-note">
          No usage was recorded. Historical token details cannot be recovered.
        </p>
      )}
      <p className="usage-note">
        Includes reported compaction and subagent usage. Cache writes store input for future reuse.
        Reasoning is included in output.
      </p>
      {summary.models.map((model) => (
        <details key={model.model} className="usage-model">
          <summary>
            {model.model} · {costs(model.costs)}
            {model.unpricedRequests ? ' (partial)' : ''}
          </summary>
          <TokenDetails tokens={model.tokens} />
        </details>
      ))}
      {records.length > 0 && (
        <details className="usage-model">
          <summary>Request costs and saved rates</summary>
          <ul className="usage-requests">
            {records.map((record) => (
              <li key={record.requestId}>
                <span>
                  {record.model} · {record.purpose} · {costs(record.cost ? [record.cost] : [])}
                </span>
                {record.pricing && (
                  <small>
                    {record.pricing.currency} per 1M tokens · Input {record.pricing.input} · Output{' '}
                    {record.pricing.output} · Cache read {record.pricing.cacheRead ?? 'unavailable'}{' '}
                    · Cache write {record.pricing.cacheWrite ?? 'unavailable'}
                    {record.pricing.cacheWrite1h
                      ? ` · 1h write ${record.pricing.cacheWrite1h}`
                      : ''}{' '}
                    · Rate version {record.pricing.version}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
  return (
    <Popover trigger="click" title={`${scope} usage`} content={content}>
      <button type="button" className="usage-trigger" aria-label={`${scope} usage`}>
        {scope === 'Session' ? 'Session · ' : ''}
        {totalLabel} · {summary.costs.length ? '≈' : ''}
        {costs(summary.costs)}
        {partial ? ' (partial)' : ''}
        {active ? ' · In progress' : ''}
      </button>
    </Popover>
  );
});
