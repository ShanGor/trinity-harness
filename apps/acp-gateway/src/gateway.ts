import { once } from 'node:events';

import * as acp from '@agentclientprotocol/sdk';

/**
 * acp-gateway (docs/design.md §11.1/§11.2): a stdio ↔ HTTP ACP proxy.
 * Zed spawns this process (NDJSON over stdio, official
 * `@agentclientprotocol/sdk`); we forward the ACP method set to the server's
 * HTTP binding (POST /acp + GET /acp/stream) so editor clients and the Web UI
 * share ONE ACP implementation and the same session event log.
 */

/**
 * stdio NDJSON stream for the SDK's `Stream` interface.
 *
 * Two SDK pitfalls discovered the hard way (documented so nobody "simplifies"
 * this back into `ndJsonStream`):
 * 1. `ndJsonStream()` drops responses produced asynchronously when stdin
 *    half-closes (its line-buffer closes the readable on EOF and the SDK then
 *    finishes the connection lifecycle, silently discarding pending replies).
 * 2. Closing the readable controller on stdin 'end' has the same effect, and
 *    so does exiting the process there — responses may legally arrive after
 *    a half-close. Keep the process and the controller alive; the parent
 *    reaps the subprocess.
 */
export function createStdioStream(): acp.Stream {
  const decoder = new TextDecoder();
  let leftover = '';

  const readable = new ReadableStream<unknown>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer) => {
        leftover += decoder.decode(chunk, { stream: true });
        for (;;) {
          const sep = leftover.indexOf('\n');
          if (sep < 0) break;
          const line = leftover.slice(0, sep).trim();
          leftover = leftover.slice(sep + 1);
          if (line.length === 0) continue;
          try {
            controller.enqueue(JSON.parse(line));
          } catch (err) {
            console.error('[acp-gateway] discarding malformed stdin line', err);
          }
        }
      });
      // Client gone (editor closed / pipe EOF): deliberately keep running
      // and do NOT close the readable controller — the SDK would finish its
      // lifecycle and drop responses still in flight (responses can legally
      // arrive after a half-close). The parent process reaps the subprocess;
      // this matches the SDK's own example agent.
      process.stdin.on('end', () =>
        console.error('[acp-gateway] stdin closed; keeping process alive for in-flight replies'),
      );
      process.stdin.on('error', (err) => console.error('[acp-gateway] stdin error', err));
    },
  });

  const writable = new WritableStream<unknown>({
    async write(message) {
      const line = JSON.stringify(message) + '\n';
      if (!process.stdout.write(line)) {
        // stdout buffer full — respect backpressure.
        await once(process.stdout, 'drain');
      }
    },
  });

  return { writable, readable } as acp.Stream;
}

/** Minimal HTTP surface the gateway needs against the server. */
export interface GatewayHttp {
  /** POST /acp — one JSON-RPC message; resolves with the response body. */
  rpc(body: unknown): Promise<unknown>;
  /**
   * GET /acp/stream?sessionId= — invoke `onEnvelope` per JSON-RPC message
   * until the returned handle is closed. Reconnects internally.
   */
  openStream(sessionId: string, onEnvelope: (env: Record<string, unknown>) => void): () => void;
  /** POST /api/sessions/:id/approvals/:approvalId/respond (REST control). */
  respondApproval(
    sessionId: string,
    approvalId: string,
    outcome: 'allowed' | 'rejected',
  ): Promise<void>;
}

export function createHttp(serverUrl: string, token?: string): GatewayHttp {
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  return {
    async rpc(body) {
      const res = await fetch(`${serverUrl}/acp`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (res.status === 202) return {};
      const json = (await res.json()) as { error?: { message?: string } };
      if (json.error) {
        throw new Error(json.error.message ?? 'ACP request failed');
      }
      return json;
    },

    openStream(sessionId, onEnvelope) {
      let closed = false;
      let lastSeq = 0;
      // Cancelled on stop(): a parked reader.read() would otherwise hold the
      // HTTP connection (and the server's close) open forever.
      let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const run = async (): Promise<void> => {
        while (!closed) {
          try {
            const res = await fetch(
              `${serverUrl}/acp/stream?sessionId=${sessionId}` +
                (lastSeq > 0 ? `&afterSeq=${lastSeq}` : ''),
              { headers: headers() },
            );
            if (!res.ok || !res.body) {
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }
            const reader = res.body.getReader();
            currentReader = reader;
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let sep: number;
              while ((sep = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const idMatch = block.match(/^id: (\d+)$/m);
                if (idMatch) lastSeq = Math.max(lastSeq, Number(idMatch[1]));
                const dataMatch = block.match(/^data: (.*)$/m);
                if (dataMatch) {
                  try {
                    onEnvelope(JSON.parse(dataMatch[1]!.trim()) as Record<string, unknown>);
                  } catch (err) {
                    console.error('[acp-gateway] bad stream envelope', err);
                  }
                }
              }
            }
          } catch {
            // fall through to reconnect
          }
          if (!closed) await new Promise((r) => setTimeout(r, 1000));
        }
      };
      void run();
      return () => {
        closed = true;
        void currentReader?.cancel().catch(() => {});
      };
    },

    async respondApproval(sessionId, approvalId, outcome) {
      const res = await fetch(
        `${serverUrl}/api/sessions/${sessionId}/approvals/${approvalId}/respond`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ outcome }),
        },
      );
      if (!res.ok) {
        throw new Error(`respondApproval failed: ${res.status}`);
      }
    },
  };
}

/**
 * Build the ACP agent app. `http` is injected so tests can drive the gateway
 * against an in-process server without stdio.
 */
export function createAcpGateway(http: GatewayHttp): acp.AgentApp {
  // The SDK client context (for client-side methods) arrives with the
  // connection, outside any request handler.
  let clientCtx: acp.AgentContext | null = null;
  const closeStream = new Map<string, () => void>();

  const stopStream = (sessionId: string): void => {
    closeStream.get(sessionId)?.();
    closeStream.delete(sessionId);
  };

  /** Forward server stream messages to the connected ACP client. */
  const pumpStream = (sessionId: string): void => {
    stopStream(sessionId);
    closeStream.set(
      sessionId,
      http.openStream(sessionId, (env) => {
        if (env['method'] === 'session/update') {
          void clientCtx
            ?.notify(acp.methods.client.session.update, env['params'] as never)
            .catch(() => {});
          return;
        }
        if (env['method'] === 'session/request_permission') {
          const params = env['params'] as {
            sessionId: string;
            toolCall: { toolCallId: string; title: string };
            options: { optionId: string }[];
          };
          const approvalId = String(env['id'] ?? '');
          if (!clientCtx) {
            // Fail-closed (design.md §12.2): no client to ask ⇒ reject.
            void http.respondApproval(sessionId, approvalId, 'rejected').catch(() => {});
            return;
          }
          void clientCtx
            .request(acp.methods.client.session.requestPermission, params as never)
            .then((response) => {
              const outcome =
                (response.outcome as { optionId?: string } | undefined)?.['optionId'] === 'once'
                  ? 'allowed'
                  : 'rejected';
              return http.respondApproval(sessionId, approvalId, outcome);
            })
            .catch(() => {
              void http.respondApproval(sessionId, approvalId, 'rejected').catch(() => {});
            });
        }
      }),
    );
  };

  const rpcResult = async (method: string, params: unknown): Promise<unknown> => {
    const res = (await http.rpc({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })) as {
      result?: unknown;
    };
    return res.result ?? {};
  };

  return acp
    .agent({ name: 'trinity-harness' })
    .onConnect((connection) => {
      clientCtx = connection.client;
      // When the stdio client goes away, every SSE pump must stop
      // (deterministic shutdown, AGENTS.md §4.2).
      void connection.closed.then(() => {
        for (const stop of closeStream.values()) stop();
        closeStream.clear();
        clientCtx = null;
      });
    })
    .onRequest(
      'initialize',
      (ctx) => rpcResult('initialize', ctx.params) as Promise<acp.InitializeResponse>,
    )
    .onRequest(
      'authenticate',
      (ctx) => rpcResult('authenticate', ctx.params) as Promise<acp.AuthenticateResponse>,
    )
    .onRequest('session/new', async (ctx) => {
      const result = (await rpcResult('session/new', ctx.params)) as { sessionId: string };
      pumpStream(result.sessionId);
      return result as acp.NewSessionResponse;
    })
    .onRequest(
      'session/load',
      (ctx) => rpcResult('session/load', ctx.params) as Promise<acp.LoadSessionResponse>,
    )
    .onRequest(
      'session/prompt',
      (ctx) => rpcResult('session/prompt', ctx.params) as Promise<acp.PromptResponse>,
    )
    .onRequest(
      'session/set_config_option',
      (ctx) =>
        rpcResult(
          'session/set_config_option',
          ctx.params,
        ) as Promise<acp.SetSessionConfigOptionResponse>,
    )
    .onNotification('session/cancel', (ctx) => {
      void http
        .rpc({ jsonrpc: '2.0', method: 'session/cancel', params: ctx.params })
        .catch(() => {});
    });
}
