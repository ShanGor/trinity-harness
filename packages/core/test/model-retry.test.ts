import { describe, expect, it } from 'vitest';
import { classifyModelFailure, modelRetry } from '../src/loop/model-retry.js';

const now = Date.parse('2026-10-22T03:00:00.000Z');
const failure = (responseHeaders: Record<string, string>, statusCode = 429) =>
  Object.assign(new Error('provider failure'), { statusCode, responseHeaders });

describe('provider retry scheduling', () => {
  it.each([
    [{ 'Retry-After': '12' }, 12_000, 'retry-after'],
    [{ 'retry-after': '1.5' }, 1500, 'retry-after'],
    [{ 'retry-after-ms': '2500', 'retry-after': '10' }, 2500, 'retry-after-ms'],
    [{ 'retry-after': 'Thu, 22 Oct 2026 03:01:00 GMT' }, 60_000, 'retry-after'],
    [{ 'retry-after': 'Thu, 22 Oct 2026 02:59:00 GMT' }, 1000, 'backoff'],
    [{ 'retry-after': '0' }, 1000, 'backoff'],
    [{ 'retry-after-ms': 'no', 'retry-after': '4' }, 4000, 'retry-after'],
    [{ 'retry-after': '-1' }, 1000, 'backoff'],
    [{ 'retry-after': 'Infinity' }, 1000, 'backoff'],
    [{ 'retry-after': 'not a date' }, 1000, 'backoff'],
    [{ 'retry-after-ms': '' }, 1000, 'backoff'],
    [{ 'retry-after': '99999999' }, 900_000, 'retry-after'],
    [{}, 1000, 'backoff'],
  ] as const)('schedules %j', (headers, delayMs, delaySource) => {
    expect(modelRetry(failure(headers), 1, now)).toMatchObject({
      attempt: 1,
      reason: 'rate_limit',
      statusCode: 429,
      delayMs,
      delaySource,
      retryAt: new Date(now + delayMs).toISOString(),
    });
  });
  it('never shortens the fallback backoff for a smaller provider hint', () => {
    expect(modelRetry(failure({ 'retry-after': '1' }), 3, now)).toMatchObject({
      delayMs: 4000,
      delaySource: 'backoff',
    });
  });
  it('uses the latest reset of exhausted buckets, ignoring available buckets', () => {
    expect(
      modelRetry(
        failure({
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-requests': '1m2.5s',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '2m',
          'anthropic-ratelimit-input-tokens-remaining': '5',
          'anthropic-ratelimit-input-tokens-reset': '2026-10-22T03:10:00Z',
        }),
        1,
        now,
      ),
    ).toMatchObject({
      delayMs: 120_000,
      delaySource: 'rate-limit-reset',
      exhausted: ['requests', 'tokens'],
    });
  });
  it('reads Anthropic resets and retains only safe diagnostic fields', () => {
    const error = failure(
      {
        'Anthropic-Ratelimit-Input-Tokens-Remaining': '0',
        'Anthropic-Ratelimit-Input-Tokens-Reset': '2026-10-22T03:00:30Z',
        'x-api-key': 'private-key',
        'set-cookie': 'private-cookie',
      },
      529,
    );
    Object.assign(error, {
      requestBodyValues: { prompt: 'private-prompt' },
      responseBody: 'private-body',
    });
    const retry = modelRetry(error, 1, now);
    expect(retry).toMatchObject({
      delayMs: 30_000,
      reason: 'overloaded',
      exhausted: ['input_tokens'],
    });
    expect(JSON.stringify(retry)).not.toMatch(/private/);
  });
  it('does not guess exhaustion or parse invalid reset times', () => {
    expect(
      modelRetry(
        failure({
          'x-ratelimit-reset-requests': '10m',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '1e10s',
        }),
        1,
        now,
      ),
    ).toMatchObject({ delayMs: 1000, delaySource: 'backoff', exhausted: ['tokens'] });
  });
  it('follows bounded cause chains and handles cycles', () => {
    const error = Object.assign(new Error('wrapper'), { cause: failure({ 'retry-after': '5' }) });
    expect(classifyModelFailure(error)).toBe('retry');
    expect(modelRetry(error, 1, now)).toMatchObject({ delayMs: 5000, statusCode: 429 });
    const cycle = Object.assign(new Error('cycle'), { cause: undefined as unknown });
    cycle.cause = cycle;
    expect(classifyModelFailure(cycle)).toBe('fatal');
  });
  it.each(['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low'])(
    'does not retry permanent quota error %s',
    (code) => {
      expect(
        classifyModelFailure(
          Object.assign(failure({}), {
            isRetryable: true,
            data: { error: { code } },
          }),
        ),
      ).toBe('fatal');
    },
  );
  it.each([401, 403])('does not override HTTP %i with retry hints', (status) => {
    expect(
      classifyModelFailure(
        Object.assign(failure({ 'retry-after': '1' }, status), { isRetryable: true }),
      ),
    ).toBe('fatal');
  });
  it('recognizes 529 even without an SDK retryability flag', () => {
    expect(classifyModelFailure(failure({}, 529))).toBe('retry');
  });
});
