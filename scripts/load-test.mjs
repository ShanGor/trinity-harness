#!/usr/bin/env node
/**
 * M5 load test (docs/design.md §18 性能压测): hammers the stateless API tier —
 * auth, prompt enqueue, and SSE replay fan-out — against a RUNNING server
 * (distributed or inline mode; no LLM key required: prompts enqueue and the
 * committed user message already seeds the replay stream).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node scripts/load-test.mjs [concurrency]
 *   # or skip login: TOKEN=<bearer> node scripts/load-test.mjs
 *
 * Reports p50/p95/p99 latencies + throughput per phase and exits non-zero
 * when error rates exceed the threshold (default 1%).
 */

const BASE_URL = (process.env['BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env['TOKEN'];
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'admin@trinity.local';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'];
const CONCURRENCY = Math.max(1, Number(process.argv[2] ?? process.env['CONCURRENCY'] ?? 20));
const SSE_CLIENTS = Math.max(CONCURRENCY, Number(process.env['SSE_CLIENTS'] ?? 50));
const ERROR_THRESHOLD = Number(process.env['ERROR_THRESHOLD'] ?? 0.01);

/** @param {number[]} samples sorted ascending */
function percentiles(samples) {
  if (samples.length === 0) return { p50: NaN, p95: NaN, p99: NaN };
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

async function login() {
  if (TOKEN) return TOKEN;
  if (!ADMIN_PASSWORD) {
    throw new Error('TOKEN or ADMIN_PASSWORD is required for the load test');
  }
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).token;
}

const authed = (token, path, init = {}) =>
  fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

async function runPhase(name, total, worker) {
  const samples = [];
  let errors = 0;
  const startedAt = Date.now();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= total) return;
        const t0 = performance.now();
        try {
          await worker(i);
          samples.push(performance.now() - t0);
        } catch (err) {
          errors += 1;
          if (errors <= 3) console.error(`  [${name}] error:`, err.message);
        }
      }
    }),
  );
  const wallMs = Date.now() - startedAt;
  const p = percentiles([...samples].sort((a, b) => a - b));
  const rate = samples.length / (wallMs / 1000);
  console.log(
    `${name.padEnd(28)} n=${String(samples.length).padStart(5)} ` +
      `err=${errors}  rps=${rate.toFixed(1).padStart(7)}  ` +
      `p50=${p.p50.toFixed(1)}ms p95=${p.p95.toFixed(1)}ms p99=${p.p99.toFixed(1)}ms`,
  );
  return { samples: samples.length, errors };
}

/** One SSE client: connects with afterSeq=0, reads events until `target` lines. */
async function sseReplay(sessionId, token, target) {
  const res = await authed(token, `/api/sessions/${sessionId}/events?afterSeq=0`, {
    headers: { accept: 'text/event-stream' },
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let events = 0;
  let buffer = '';
  const t0 = performance.now();
  // Hard ceiling so a stalled stream can never hang the whole run.
  const deadline = setTimeout(() => reader.cancel().catch(() => {}), 30_000);
  try {
    while (events < target) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // Frames look like "id: <seq>\ndata: <json>" — count data-bearing ones.
        if (frame.split('\n').some((line) => line.startsWith('data:'))) events += 1;
      }
    }
    if (events < target) throw new Error(`only ${events}/${target} events received`);
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => {});
  }
  return performance.now() - t0;
}

async function main() {
  console.log(`load test → ${BASE_URL}  (concurrency=${CONCURRENCY}, sseClients=${SSE_CLIENTS})`);
  const token = await login();

  const totals = { samples: 0, errors: 0 };
  const accumulate = (r) => {
    totals.samples += r.samples;
    totals.errors += r.errors;
  };

  // Phase 1: auth token verification round-trips.
  accumulate(
    await runPhase('auth /api/me', CONCURRENCY * 5, () => authed(token, '/api/me').then(ensureOk)),
  );

  // Phase 2: session create + prompt enqueue (fire-and-forget 202s).
  let seeded = null;
  accumulate(
    await runPhase('session create + prompt', CONCURRENCY * 5, async () => {
      const created = await authed(token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: 'load' }),
      });
      ensureOk(created, 201);
      const { sessionId } = await created.json();
      const posted = await authed(token, `/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: `load ${Math.random()}` }),
      });
      ensureOk(posted, 202);
      seeded ??= sessionId;
    }),
  );

  if (!seeded) throw new Error('no session was seeded — cannot run the SSE phase');

  // Give the relay a moment to publish the committed user message.
  await new Promise((r) => setTimeout(r, 500));

  // Phase 3: SSE replay fan-out — many concurrent clients, same session.
  // The replay's first data frame is the committed user message
  // (session/created is log-only and not mapped onto the wire by design).
  const targetEvents = 1;
  const wallStart = Date.now();
  const latencies = await Promise.all(
    Array.from({ length: SSE_CLIENTS }, () => sseReplay(seeded, token, targetEvents)),
  );
  const wallMs = Date.now() - wallStart;
  const p = percentiles([...latencies].sort((a, b) => a - b));
  console.log(
    `${'SSE replay fan-out'.padEnd(28)} n=${String(latencies.length).padStart(5)} ` +
      `err=0  wall=${wallMs}ms  p50=${p.p50.toFixed(1)}ms p95=${p.p95.toFixed(1)}ms p99=${p.p99.toFixed(1)}ms`,
  );

  const errorRate = totals.errors / Math.max(1, totals.samples);
  console.log(
    `\nerror rate: ${(errorRate * 100).toFixed(2)}% (threshold ${ERROR_THRESHOLD * 100}%)`,
  );
  if (errorRate > ERROR_THRESHOLD) {
    console.error('LOAD TEST FAILED: error rate above threshold');
    process.exit(1);
  }
  console.log('LOAD TEST PASSED');
}

function ensureOk(res, expected = 200) {
  if (res.status !== expected)
    throw new Error(`unexpected status ${res.status} (want ${expected})`);
}

main().catch((err) => {
  console.error('LOAD TEST FAILED:', err.message);
  process.exit(1);
});
