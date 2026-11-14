import { Agent, request as httpRequest, type ClientRequestArgs } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import {
  GUEST_WIRE_BYTES,
  guestResponseSchema,
  environmentRecordSchema,
  guestEnvelopeSchema,
  type GuestRelayPort,
  type BrowserGuestRelayPort,
  type EnvironmentRecord,
  type GuestEnvelope,
  type GuestValue,
} from '@trinity-harness/contracts';

/** One generation-specific vsock connection; no guest-provided network address. */
export class FirecrackerGuestRelay implements GuestRelayPort, BrowserGuestRelayPort {
  constructor(private readonly stateRoot = '/srv/trinity-node') {}
  async call(
    input: EnvironmentRecord,
    envelope: GuestEnvelope,
    signal?: AbortSignal,
  ): Promise<GuestValue> {
    return this.relay(input, envelope, 4050, signal);
  }
  async callBrowser(
    input: EnvironmentRecord,
    envelope: GuestEnvelope,
    signal?: AbortSignal,
  ): Promise<GuestValue> {
    return this.relay(input, envelope, 4051, signal);
  }
  private async relay(
    input: EnvironmentRecord,
    envelope: GuestEnvelope,
    port: 4050 | 4051,
    signal?: AbortSignal,
  ): Promise<GuestValue> {
    const environment = environmentRecordSchema.parse(input);
    const rpc = guestEnvelopeSchema.parse(envelope);
    if (rpc.environmentId !== environment.id || rpc.generation !== environment.generation)
      throw new Error('Guest binding mismatch');
    const socketPath = `${this.stateRoot}/jailer/firecracker/${environment.generation}/root/vsock.sock`;
    const active = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(125_000)]);
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = (
      _options: ClientRequestArgs,
      callback?: (error: Error | null, stream: Duplex) => void,
    ): undefined => {
      if (!callback) throw new Error('Async vsock callback required');
      // Only connection establishment is retried. No HTTP request bytes have
      // reached the guest until callback succeeds; never retry an RPC.
      const connecting = AbortSignal.any([active, AbortSignal.timeout(60_000)]);
      const attempt = (): void => {
        const socket = connect({ path: socketPath, signal: active });
        const handshakeDeadline = AbortSignal.timeout(2000);
        let header = Buffer.alloc(0);
        let complete = false;
        const fail = (error: Error): void => {
          if (!complete) {
            complete = true;
            connecting.removeEventListener('abort', aborted);
            handshakeDeadline.removeEventListener('abort', booting);
            socket.removeListener('end', booting);
            socket.removeListener('close', booting);
            const code = (error as NodeJS.ErrnoException).code;
            if (
              !connecting.aborted &&
              ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'GUEST_BOOTING'].includes(
                code ?? '',
              )
            ) {
              void delay(500, undefined, { signal: connecting }).then(attempt, (failure: unknown) =>
                callback(failure as Error, socket),
              );
            } else callback(error, socket);
          }
          socket.destroy();
        };
        const aborted = (): void =>
          fail(new Error('Guest connection startup timed out or was cancelled'));
        // An early vsock CONNECT can close cleanly or remain unanswered while
        // the guest listener starts. No HTTP bytes are sent before its OK.
        const booting = (): void =>
          fail(Object.assign(new Error('Guest CONNECT is not ready'), { code: 'GUEST_BOOTING' }));
        connecting.addEventListener('abort', aborted, { once: true });
        handshakeDeadline.addEventListener('abort', booting, { once: true });
        socket.once('end', booting);
        socket.once('close', booting);
        socket.once('error', fail);
        if (connecting.aborted) {
          aborted();
          return;
        }
        const read = (chunk: Buffer): void => {
          header = Buffer.concat([header, chunk]);
          const newline = header.indexOf(10);
          if (newline < 0) {
            if (header.length > 80) fail(new Error('Invalid vsock handshake'));
            return;
          }
          if (newline > 80 || !/^OK [0-9]+$/.test(header.subarray(0, newline).toString('ascii'))) {
            fail(
              Object.assign(new Error('Rejected vsock connection'), {
                code: header.subarray(0, newline).toString('ascii').startsWith('ERR ')
                  ? 'GUEST_BOOTING'
                  : 'INVALID_HANDSHAKE',
              }),
            );
            return;
          }
          complete = true;
          connecting.removeEventListener('abort', aborted);
          handshakeDeadline.removeEventListener('abort', booting);
          socket.removeListener('end', booting);
          socket.removeListener('close', booting);
          socket.removeListener('data', read);
          socket.removeListener('error', fail);
          socket.pause();
          if (newline + 1 < header.length) socket.unshift(header.subarray(newline + 1));
          callback(null, socket);
          socket.resume();
        };
        socket.on('data', read);
        socket.once('connect', () => socket.write(`CONNECT ${port}\n`));
      };
      attempt();
      return undefined;
    };
    try {
      // The vsock listener may accept CONNECT before systemd's Unix-socket
      // proxy can reach the guest HTTP server. Probe its fixed, read-only 404
      // route first; only these probes may be retried after HTTP dispatch.
      const readiness = AbortSignal.any([active, AbortSignal.timeout(60_000)]);
      for (;;) {
        try {
          await new Promise<void>((resolve, reject) => {
            const probe = httpRequest(
              { host: 'guest', port: 80, path: '/', method: 'GET', agent, signal: readiness },
              (response) => {
                let size = 0;
                response.on('error', reject);
                response.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > 1024) response.destroy(new Error('Guest readiness response overflow'));
                });
                response.once('end', () => {
                  if (response.statusCode === 404) resolve();
                  else reject(new Error('Guest readiness response unavailable'));
                });
              },
            );
            probe.once('error', reject);
            probe.end();
          });
          break;
        } catch (error) {
          readiness.throwIfAborted();
          const code = (error as NodeJS.ErrnoException).code;
          if (!['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(code ?? '')) throw error;
          await delay(500, undefined, { signal: readiness });
        }
      }
      return await new Promise<GuestValue>((resolve, reject) => {
        const body = JSON.stringify(rpc);
        const request = httpRequest(
          {
            host: 'guest',
            port: 80,
            path: '/rpc',
            method: 'POST',
            agent,
            signal: active,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('error', reject);
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > GUEST_WIRE_BYTES) {
                response.destroy();
                reject(new Error('Guest response overflow'));
              } else chunks.push(chunk);
            });
            response.once('end', () => {
              try {
                if (response.statusCode !== 200)
                  throw new Error('Guest operation failed; effect may be unknown');
                const result = guestResponseSchema.parse(
                  JSON.parse(Buffer.concat(chunks).toString('utf8')),
                );
                if (result.requestId !== rpc.requestId || result.generation !== rpc.generation)
                  throw new Error('Stale guest response');
                resolve(result.value);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.once('error', reject);
        request.end(body);
      });
    } finally {
      agent.destroy();
    }
  }
}
