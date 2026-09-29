import type {
  ApprovalHub,
  ApprovalListener,
  ApprovalReply,
  ApprovalRequest,
  ApprovalRequester,
} from '@trinity-harness/contracts';
import type { Redis } from 'ioredis';

/**
 * Cross-process human-in-the-loop approval channel (docs/design.md §12.2),
 * built on Redis Pub/Sub:
 *
 * - `sessappr:req:{sessionId}`  worker → server(s): fan the request out to
 *   every connected UI / acp-gateway listener (multicast — first reply wins,
 *   idempotent at the PG store);
 * - `sessappr:res:{sessionId}`  server → worker(s): route the first reply
 *   back; pending waits are keyed by approvalId so stray replies are ignored.
 *
 * Fail-closed (§12.2/AGENTS.md §3.4): no listener, no reply, or an aborted
 * turn all resolve to REJECTED — never to allowed.
 */

export const approvalRequestChannel = (sessionId: string): string => `sessappr:req:${sessionId}`;
export const approvalReplyChannel = (sessionId: string): string => `sessappr:res:${sessionId}`;

/** Default how long a worker waits for the human before auto-rejecting. */
export const APPROVAL_TIMEOUT_MS = 120_000;

interface ReplyEnvelope {
  approvalId: string;
  outcome: 'allowed' | 'rejected';
  decidedBy: string;
}

export class RedisApprovalHub implements ApprovalHub {
  constructor(private readonly redis: Redis) {}

  listen(sessionId: string): ApprovalListener {
    const reqConn = this.redis.duplicate();
    const resConn = this.redis.duplicate();
    let stopped = false;
    let requestHandler: ((req: ApprovalRequest) => void) | null = null;

    void reqConn.subscribe(approvalRequestChannel(sessionId)).catch((err) => {
      if (!stopped) console.error('[RedisApprovalHub] subscribe failed', err);
    });
    reqConn.on('message', (_channel: string, message: string) => {
      if (stopped || !requestHandler) return;
      try {
        requestHandler(JSON.parse(message) as ApprovalRequest);
      } catch (err) {
        console.error('[RedisApprovalHub] bad request payload', err);
      }
    });

    return {
      onRequest: (handler) => {
        requestHandler = handler;
      },
      reply: (reply) => {
        const envelope: ReplyEnvelope = reply;
        void resConn
          .publish(approvalReplyChannel(sessionId), JSON.stringify(envelope))
          .catch(() => {});
      },
      dispose: () => {
        stopped = true;
        reqConn.disconnect();
        resConn.disconnect();
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
  }
}

export interface ApprovalClientOptions {
  /** How long to wait for the human before auto-rejecting (fail-closed). */
  timeoutMs?: number;
}

export class RedisApprovalRequester implements ApprovalRequester {
  private readonly timeoutMs: number;

  constructor(
    private readonly redis: Redis,
    opts?: ApprovalClientOptions,
  ) {
    this.timeoutMs = opts?.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  }

  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalReply> {
    return new Promise<ApprovalReply>((resolve) => {
      // A subscribed connection cannot run other commands (ioredis enters
      // subscriber mode): publish on the constructor connection, listen on a
      // dedicated duplicate.
      const conn = this.redis.duplicate();
      let settled = false;
      const finish = (reply: ApprovalReply): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        conn.disconnect();
        resolve(reply);
      };
      const reject = (decidedBy: string): void =>
        finish({ approvalId: req.approvalId, outcome: 'rejected', decidedBy });

      const timer = setTimeout(() => reject('timeout'), this.timeoutMs);
      const onAbort = (): void => reject('cancelled');
      if (signal) {
        if (signal.aborted) {
          reject('cancelled');
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      void (async () => {
        try {
          await conn.subscribe(approvalReplyChannel(req.sessionId));
          conn.on('message', (_channel: string, message: string) => {
            try {
              const env = JSON.parse(message) as ReplyEnvelope;
              // Stray/duplicate replies for other requests are ignored.
              if (env.approvalId !== req.approvalId) return;
              finish({
                approvalId: req.approvalId,
                outcome: env.outcome,
                decidedBy: env.decidedBy,
              });
            } catch {
              // malformed envelope — keep waiting until timeout
            }
          });
          await this.redis.publish(approvalRequestChannel(req.sessionId), JSON.stringify(req));
        } catch {
          // Redis unreachable ⇒ fail closed immediately.
          reject('unreachable');
        }
      })();
    });
  }
}
