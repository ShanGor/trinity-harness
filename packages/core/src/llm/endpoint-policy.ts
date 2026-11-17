import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { LlmConfigurationError, type LlmEndpointPolicyPort } from '@trinity-harness/contracts';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
export function isPublicProviderAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  // Global unicast only; reject mapped addresses, ULA, link-local and transition ranges.
  return (
    isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, 'ipv6')
  );
}
export interface ProviderEndpointRule {
  origin: string;
  allowPrivate?: boolean;
}
/** Exact operator origins, no redirects/proxy inheritance; DNS address is pinned at connect. */
export class ProviderEndpointPolicy implements LlmEndpointPolicyPort {
  private readonly rules: Map<string, ProviderEndpointRule>;
  constructor(
    rules: ProviderEndpointRule[],
    private readonly resolve: typeof lookup = lookup,
  ) {
    this.rules = new Map(
      rules.map((rule) => {
        const url = new URL(rule.origin);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error('Provider policy requires an HTTPS origin');
        return [url.origin, rule];
      }),
    );
  }
  private origin(endpoint: string): { url: URL; rule: ProviderEndpointRule } {
    const denied = (): never => {
      throw new LlmConfigurationError('INVALID', 'Provider endpoint denied by operator policy');
    };
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return denied();
    }
    if (
      endpoint.length > 2048 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return denied();
    const rule = this.rules.get(url.origin);
    if (!rule)
      throw new LlmConfigurationError(
        'INVALID',
        'Provider origin is not allowed. Add its HTTPS origin to LLM_PROVIDER_DESTINATIONS on the server and worker.',
      );
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) && !rule.allowPrivate && !isPublicProviderAddress(hostname)) return denied();
    return { url, rule };
  }
  validateConfiguration(endpoint: string): void {
    this.origin(endpoint);
  }
  private async target(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<{ url: URL; address: string; family: number }> {
    const { url, rule } = this.origin(endpoint);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    signal?.throwIfAborted();
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
    let addresses: { address: string; family: number }[];
    try {
      addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await new Promise((resolve, reject) => {
            const abort = (): void => {
              deadline.removeEventListener('abort', abort);
              reject(deadline.reason);
            };
            deadline.addEventListener('abort', abort, { once: true });
            void this.resolve(hostname, { all: true, verbatim: true }).then(
              (value) => {
                deadline.removeEventListener('abort', abort);
                resolve(value);
              },
              (error) => {
                deadline.removeEventListener('abort', abort);
                reject(error);
              },
            );
          });
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(
        new LlmConfigurationError('UNAVAILABLE', 'Provider address unavailable'),
        { isRetryable: true },
      );
    }
    signal?.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some((item) => !rule.allowPrivate && !isPublicProviderAddress(item.address))
    )
      throw new LlmConfigurationError('INVALID', 'Provider endpoint denied by operator policy');
    return { url, ...addresses[0]! };
  }
  async validate(endpoint: string, signal?: AbortSignal): Promise<void> {
    await this.target(endpoint, signal);
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const { url, address, family } = await this.target(req.url, req.signal);
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    if (body && body.length > 32 * 1024 * 1024)
      throw new LlmConfigurationError('INVALID', 'Provider request exceeds transport limit');
    const requestHeaders: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      requestHeaders[key] = value;
    });
    requestHeaders['accept-encoding'] = 'identity';
    const response = await new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(
        url,
        {
          method: req.method,
          headers: requestHeaders,
          signal: req.signal,
          family,
          // Keep original hostname for TLS SNI/verification, bypass a second DNS lookup.
          lookup: (_hostname, _options, callback) => callback(null, address, family),
          agent: false,
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            incoming.destroy();
            reject(new LlmConfigurationError('INVALID', 'Provider redirects are prohibited'));
            return;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined)
              for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
          }
          resolve(
            new Response(
              status === 204 || status === 304
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
    return response;
  };
}
