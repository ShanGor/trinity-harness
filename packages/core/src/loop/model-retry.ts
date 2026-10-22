import { z } from 'zod';
import { modelRetrySchema, type ModelRetry } from '@trinity-harness/contracts';

const failureSchema = z.object({
  statusCode: z.number().int().min(100).max(599).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  isRetryable: z.boolean().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  data: z.unknown().optional(),
  cause: z.unknown().optional(),
});
const providerDataSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  error: z
    .object({ code: z.union([z.string(), z.number()]).optional(), type: z.string().optional() })
    .optional(),
});
const permanentQuotaCodes = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'credit_balance_too_low',
  'billing_not_active',
]);

function failures(error: unknown): z.infer<typeof failureSchema>[] {
  const seen = new Set<unknown>();
  const result: z.infer<typeof failureSchema>[] = [];
  while (error !== undefined && !seen.has(error) && result.length < 8) {
    seen.add(error);
    const parsed = failureSchema.safeParse(error);
    if (!parsed.success) break;
    result.push(parsed.data);
    error = parsed.data.cause;
  }
  return result;
}

/** Provider-independent classification; raw messages/headers never enter the log. */
export function classifyModelFailure(error: unknown): 'overflow' | 'retry' | 'fatal' {
  const chain = failures(error);
  const codes = chain.flatMap((failure) => {
    const parsed = providerDataSchema.safeParse(failure.data);
    return [
      failure.code,
      ...(parsed.success
        ? [parsed.data.code, parsed.data.type, parsed.data.error?.code, parsed.data.error?.type]
        : []),
    ].map((value) => String(value).toLowerCase());
  });
  if (codes.some((code) => permanentQuotaCodes.has(code))) return 'fatal';
  // Authentication and permission failures take precedence over retry hints.
  if (chain.some((failure) => [401, 403].includes(failure.statusCode ?? 0))) return 'fatal';
  if (
    chain.some((failure) =>
      /(context[_ -]?(length|window)|maximum context|too many tokens|prompt.{0,30}too long)/i.test(
        failure.message ?? '',
      ),
    )
  )
    return 'overflow';
  if (chain.some((failure) => [400, 404].includes(failure.statusCode ?? 0))) return 'fatal';
  return chain.some(
    (failure) =>
      failure.isRetryable === true ||
      [408, 429, 500, 502, 503, 504, 529].includes(failure.statusCode ?? 0) ||
      ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(failure.code ?? '') ||
      /stream interrupted|socket closed|fetch failed/i.test(failure.message ?? ''),
  )
    ? 'retry'
    : 'fatal';
}

function nonnegative(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function resetDelay(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  // OpenAI reset headers are durations (e.g. 1m2.5s); Anthropic uses ISO dates.
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(text)) {
    let ms = 0;
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g))
      ms += Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!] ?? 0);
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

/** The provider delay is a minimum over backoff, bounded to fifteen minutes. */
export function modelRetry(error: unknown, attempt: number, now: number): ModelRetry {
  const chain = failures(error);
  const failure = chain.find((item) => item.statusCode !== undefined);
  const statusCode = failure?.statusCode;
  const headers = Object.fromEntries(
    chain
      .toReversed()
      .flatMap((item) =>
        Object.entries(item.responseHeaders ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
  );
  const exhausted: ModelRetry['exhausted'] = [];
  const resets: number[] = [];
  for (const [bucket, prefix, suffix] of [
    ['requests', 'x-ratelimit-', 'requests'],
    ['tokens', 'x-ratelimit-', 'tokens'],
    ['requests', 'anthropic-ratelimit-', 'requests'],
    ['tokens', 'anthropic-ratelimit-', 'tokens'],
    ['input_tokens', 'anthropic-ratelimit-', 'input-tokens'],
    ['output_tokens', 'anthropic-ratelimit-', 'output-tokens'],
  ] as const) {
    const remainingKey =
      prefix === 'x-ratelimit-' ? `${prefix}remaining-${suffix}` : `${prefix}${suffix}-remaining`;
    const resetKey =
      prefix === 'x-ratelimit-' ? `${prefix}reset-${suffix}` : `${prefix}${suffix}-reset`;
    if (nonnegative(headers[remainingKey]) !== 0) continue;
    if (!exhausted.includes(bucket)) exhausted.push(bucket);
    const reset = resetDelay(headers[resetKey], now);
    if (reset !== undefined) resets.push(reset);
  }
  let providerDelay = nonnegative(headers['retry-after-ms']);
  let delaySource: ModelRetry['delaySource'] = 'retry-after-ms';
  if (providerDelay === undefined) {
    delaySource = 'retry-after';
    const value = headers['retry-after'];
    const seconds = nonnegative(value);
    if (seconds !== undefined) providerDelay = seconds * 1000;
    else if (value && /^[A-Za-z]{3},/.test(value.trim())) {
      const date = Date.parse(value);
      if (Number.isFinite(date)) providerDelay = Math.max(0, date - now);
    }
  }
  if (providerDelay === undefined && resets.length) {
    delaySource = 'rate-limit-reset';
    providerDelay = Math.max(...resets);
  }
  const backoff = Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 8000);
  if (providerDelay === undefined || providerDelay < backoff) delaySource = 'backoff';
  const delayMs = Math.ceil(Math.min(900_000, Math.max(backoff, providerDelay ?? 0)));
  return modelRetrySchema.parse({
    attempt,
    reason:
      statusCode === 429
        ? 'rate_limit'
        : statusCode === 529
          ? 'overloaded'
          : statusCode === undefined || statusCode === 408
            ? 'transport'
            : 'server_error',
    ...(statusCode === undefined ? {} : { statusCode }),
    delayMs,
    retryAt: new Date(now + delayMs).toISOString(),
    delaySource,
    exhausted,
  });
}

export function retryProgress(retry: ModelRetry): string {
  const reason = {
    rate_limit: 'Provider rate limit',
    overloaded: 'Provider overloaded',
    server_error: 'Provider server error',
    transport: 'Provider connection interrupted',
  }[retry.reason];
  return `${reason}${retry.statusCode ? ` (HTTP ${retry.statusCode})` : ''}${retry.exhausted.length ? `: ${retry.exhausted.join(', ')}` : ''}. Retry ${retry.attempt} scheduled for ${retry.retryAt} (in ${Math.ceil(retry.delayMs / 1000)} seconds).`;
}
